// npx vitest run api/providers/__tests__/openai-timeout.spec.ts

import { OpenAiHandler } from "../openai"
import { ApiHandlerOptions } from "../../../shared/api"

// Mock the timeout config utility
vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"

import { clearAllMocks } from "../../../test-utils/reset"

// Mock OpenAI and AzureOpenAI
const mockOpenAIConstructor = vitest.fn()
const mockAzureOpenAIConstructor = vitest.fn()

vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation(function (config) {
			mockOpenAIConstructor(config)
			return {
				chat: {
					completions: {
						create: vitest.fn(),
					},
				},
			}
		}),
		AzureOpenAI: vitest.fn().mockImplementation(function (config) {
			mockAzureOpenAIConstructor(config)
			return {
				chat: {
					completions: {
						create: vitest.fn(),
					},
				},
			}
		}),
	}
})

// Mock undici so the transport deadline the handler builds is observable.
// vi.hoisted keeps the doubles usable by the hoisted mock factories below,
// which run before this module's top-level consts initialize.
const { mockAgentInstance, mockAgentConstructor, mockUndiciFetch, mockIsProxyEnabled } = vi.hoisted(() => {
	const agentInstance = { undiciAgent: true }
	// A constructable double: the transport calls `new Agent(options)`, so the
	// implementation must be a plain function (an arrow is not a constructor).
	const agentDouble = function AgentDouble(this: unknown) {
		return agentInstance
	}
	return {
		mockAgentInstance: agentInstance,
		mockAgentConstructor: vitest.fn(agentDouble),
		mockUndiciFetch: vitest.fn(),
		mockIsProxyEnabled: vitest.fn(() => false),
	}
})

vitest.mock("undici", () => ({
	__esModule: true,
	Agent: mockAgentConstructor,
	fetch: mockUndiciFetch,
}))

// The transport must not opt out of the deadline while tests run.
vitest.mock("../../../utils/networkProxy", () => ({
	__esModule: true,
	isProxyEnabled: () => mockIsProxyEnabled(),
}))

describe("OpenAiHandler timeout configuration", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("should use default timeout for standard OpenAI", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		const options: ApiHandlerOptions = {
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiApiKey: "test-key",
		}

		new OpenAiHandler(options)

		expect(getApiRequestTimeout).toHaveBeenCalled()
		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.openai.com/v1",
				apiKey: "test-key",
				timeout: 600000, // 600 seconds in milliseconds
			}),
		)
	})

	it("should use custom timeout for OpenAI-compatible providers", () => {
		;(getApiRequestTimeout as any).mockReturnValue(1800000) // 30 minutes

		const options: ApiHandlerOptions = {
			apiModelId: "custom-model",
			openAiModelId: "custom-model",
			openAiBaseUrl: "http://localhost:8080/v1",
			openAiApiKey: "test-key",
		}

		new OpenAiHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "http://localhost:8080/v1",
				timeout: 1800000, // 1800 seconds in milliseconds
			}),
		)
	})

	it("should use timeout for Azure OpenAI", () => {
		;(getApiRequestTimeout as any).mockReturnValue(900000) // 15 minutes

		const options: ApiHandlerOptions = {
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiBaseUrl: "https://myinstance.openai.azure.com",
			openAiApiKey: "test-key",
			openAiUseAzure: true,
		}

		new OpenAiHandler(options)

		expect(mockAzureOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 900000, // 900 seconds in milliseconds
			}),
		)
	})

	it("should use timeout for Azure AI Inference", () => {
		;(getApiRequestTimeout as any).mockReturnValue(1200000) // 20 minutes

		const options: ApiHandlerOptions = {
			apiModelId: "deepseek",
			openAiModelId: "deepseek",
			openAiBaseUrl: "https://myinstance.services.ai.azure.com",
			openAiApiKey: "test-key",
		}

		new OpenAiHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 1200000, // 1200 seconds in milliseconds
			}),
		)
	})

	it("should handle zero timeout (no timeout)", () => {
		;(getApiRequestTimeout as any).mockReturnValue(0)

		const options: ApiHandlerOptions = {
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
		}

		new OpenAiHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 0, // No timeout
			}),
		)
	})
})

describe("OpenAiHandler transport deadline", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it.each([
		{ label: "standard OpenAI", timeoutMs: 600000, baseUrl: undefined, useAzure: undefined },
		{ label: "OpenAI-compatible", timeoutMs: 1800000, baseUrl: "http://localhost:8080/v1", useAzure: undefined },
		{ label: "Azure OpenAI", timeoutMs: 900000, baseUrl: "https://myinstance.openai.azure.com", useAzure: true },
		{
			label: "Azure AI Inference",
			timeoutMs: 1200000,
			baseUrl: "https://myinstance.services.ai.azure.com",
			useAzure: undefined,
		},
		{ label: "zero timeout (disabled)", timeoutMs: 0, baseUrl: undefined, useAzure: undefined },
	])(
		"aligns the undici transport deadlines with the configured timeout for $label",
		({ timeoutMs, baseUrl, useAzure }) => {
			vitest.mocked(getApiRequestTimeout).mockReturnValue(timeoutMs)

			const options: ApiHandlerOptions = {
				apiModelId: "gpt-4",
				openAiModelId: "gpt-4",
				openAiApiKey: "test-key",
				...(baseUrl ? { openAiBaseUrl: baseUrl } : {}),
				...(useAzure ? { openAiUseAzure: useAzure } : {}),
			}

			new OpenAiHandler(options)

			const constructorMock = useAzure ? mockAzureOpenAIConstructor : mockOpenAIConstructor
			expect(constructorMock).toHaveBeenLastCalledWith(expect.objectContaining({ fetch: expect.any(Function) }))
			expect(mockAgentConstructor).toHaveBeenLastCalledWith(
				expect.objectContaining({ bodyTimeout: timeoutMs, headersTimeout: timeoutMs }),
			)
		},
	)

	it("routes requests through an undici fetch bound to the constructed agent", () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)

		new OpenAiHandler({
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiApiKey: "test-key",
		})

		const config = mockOpenAIConstructor.mock.calls.at(-1)?.[0] as {
			fetch?: (input: string, init?: unknown) => Promise<unknown>
		}
		expect(config?.fetch).toBeInstanceOf(Function)
		void config?.fetch?.("https://api.openai.com/v1/chat/completions", { method: "POST" })

		expect(mockUndiciFetch).toHaveBeenCalledWith(
			"https://api.openai.com/v1/chat/completions",
			expect.objectContaining({ method: "POST", dispatcher: mockAgentInstance }),
		)
	})

	it("omits the custom fetch while the debug proxy is active so the proxy dispatcher stays in charge", () => {
		mockIsProxyEnabled.mockReturnValueOnce(true)
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)

		new OpenAiHandler({
			apiModelId: "gpt-4",
			openAiModelId: "gpt-4",
			openAiApiKey: "test-key",
		})

		const config = mockOpenAIConstructor.mock.calls.at(-1)?.[0] as { fetch?: unknown }
		expect(config?.fetch).toBeUndefined()
		expect(mockAgentConstructor).not.toHaveBeenCalled()
	})
})

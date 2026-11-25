// npx vitest run api/providers/__tests__/base-openai-compatible-provider-timeout.spec.ts

import type { ModelInfo } from "@roo-code/types"

import { BaseOpenAiCompatibleProvider } from "../base-openai-compatible-provider"

// Mock the timeout config utility
vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"

import { clearAllMocks } from "../../../test-utils/reset"

// Mock OpenAI and capture constructor calls
const mockOpenAIConstructor = vitest.fn()

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
	}
})

// Mock undici so the transport deadline the provider builds is observable.
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

// Create a concrete test implementation of the abstract base class
class TestOpenAiCompatibleProvider extends BaseOpenAiCompatibleProvider<"test-model"> {
	constructor(apiKey: string) {
		const testModels: Record<"test-model", ModelInfo> = {
			"test-model": {
				maxTokens: 4096,
				contextWindow: 128000,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0.5,
				outputPrice: 1.5,
			},
		}

		super({
			providerName: "TestProvider",
			baseURL: "https://test.example.com/v1",
			defaultProviderModelId: "test-model",
			providerModels: testModels,
			apiKey,
		})
	}
}

describe("BaseOpenAiCompatibleProvider Timeout Configuration", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it("should call getApiRequestTimeout when creating the provider", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(getApiRequestTimeout).toHaveBeenCalled()
	})

	it("should pass the default timeout to the OpenAI client constructor", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000) // 600 seconds in ms

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://test.example.com/v1",
				apiKey: "test-api-key",
				timeout: 600000,
			}),
		)
	})

	it("should use custom timeout value from getApiRequestTimeout", () => {
		;(getApiRequestTimeout as any).mockReturnValue(1800000) // 30 minutes in ms

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 1800000,
			}),
		)
	})

	it("should handle zero timeout (no timeout)", () => {
		;(getApiRequestTimeout as any).mockReturnValue(0)

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 0,
			}),
		)
	})

	it("should pass DEFAULT_HEADERS to the OpenAI client constructor", () => {
		;(getApiRequestTimeout as any).mockReturnValue(600000)

		new TestOpenAiCompatibleProvider("test-api-key")

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultHeaders: expect.any(Object),
			}),
		)
	})
})

describe("BaseOpenAiCompatibleProvider transport deadline", () => {
	beforeEach(() => {
		clearAllMocks()
	})

	it.each([
		{ timeoutMs: 600000, deadline: 600000 },
		{ timeoutMs: 1800000, deadline: 1800000 },
		{ timeoutMs: 0, deadline: 0 },
	])(
		"aligns the undici transport deadlines with the configured timeout ($timeoutMs ms)",
		({ timeoutMs, deadline }) => {
			vitest.mocked(getApiRequestTimeout).mockReturnValue(timeoutMs)

			new TestOpenAiCompatibleProvider("test-api-key")

			expect(mockOpenAIConstructor).toHaveBeenLastCalledWith(
				expect.objectContaining({ fetch: expect.any(Function) }),
			)
			expect(mockAgentConstructor).toHaveBeenLastCalledWith(
				expect.objectContaining({ bodyTimeout: deadline, headersTimeout: deadline }),
			)
		},
	)

	it("routes requests through an undici fetch bound to the constructed agent", () => {
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)

		new TestOpenAiCompatibleProvider("test-api-key")

		const config = mockOpenAIConstructor.mock.calls.at(-1)?.[0] as {
			fetch?: (input: string, init?: unknown) => Promise<unknown>
		}
		expect(config?.fetch).toBeInstanceOf(Function)
		void config?.fetch?.("https://test.example.com/v1/chat/completions", { method: "POST" })

		expect(mockUndiciFetch).toHaveBeenCalledWith(
			"https://test.example.com/v1/chat/completions",
			expect.objectContaining({ method: "POST", dispatcher: mockAgentInstance }),
		)
	})

	it("omits the custom fetch while the debug proxy is active so the proxy dispatcher stays in charge", () => {
		mockIsProxyEnabled.mockReturnValueOnce(true)
		vitest.mocked(getApiRequestTimeout).mockReturnValue(600000)

		new TestOpenAiCompatibleProvider("test-api-key")

		const config = mockOpenAIConstructor.mock.calls.at(-1)?.[0] as { fetch?: unknown }
		expect(config?.fetch).toBeUndefined()
		expect(mockAgentConstructor).not.toHaveBeenCalled()
	})
})

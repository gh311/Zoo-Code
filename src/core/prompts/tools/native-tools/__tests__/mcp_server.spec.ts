import type OpenAI from "openai"

import type { McpServer, McpTool } from "@roo-code/types"

import { McpHub } from "../../../../../services/mcp/McpHub"

import { getMcpServerTools } from "../mcp_server"

// Helper type to access function tools
type FunctionTool = OpenAI.Chat.ChatCompletionTool & { type: "function" }

// Helper to get the function property from a tool
const getFunction = (tool: OpenAI.Chat.ChatCompletionTool) => (tool as FunctionTool).function

describe("getMcpServerTools", () => {
	const createMockTool = (name: string, description = "Test tool"): McpTool => ({
		name,
		description,
		inputSchema: {
			type: "object",
			properties: {},
		},
	})

	const createMockServer = (name: string, tools: McpTool[], source: "global" | "project" = "global"): McpServer => ({
		name,
		config: JSON.stringify({ type: "stdio", command: "test" }),
		status: "connected",
		source,
		tools,
	})

	const createMockMcpHub = (servers: McpServer[], aliases?: Record<string, string>): Partial<McpHub> => ({
		getServers: vi.fn().mockReturnValue(servers),
		// Explicit alias stubs for tests that only verify alias consumption.
		// A test double must not copy the production fallback: the real
		// getServerAlias fallback is covered by createRealAliasHub below.
		getServerAlias: vi.fn((name: string) => aliases?.[name] ?? name),
		registerGeneratedToolName: vi.fn(),
	})

	// Drive the real McpHub alias and binding methods with controlled
	// registry state. The constructor is bypassed (its file watchers and
	// initial connects are unrelated here); the production methods run for
	// real, so a broken fallback or binding fails these tests.
	const createRealAliasHub = (servers: McpServer[], registry: Array<[string, string]> = []): McpHub => {
		const hub = Object.create(McpHub.prototype) as McpHub
		const state = hub as unknown as {
			sanitizedNameRegistry: Map<string, string>
			generatedToolBindings: Map<string, { serverName: string; toolName: string }>
			connections: unknown[]
		}
		state.sanitizedNameRegistry = new Map(registry)
		state.generatedToolBindings = new Map()
		state.connections = []
		return Object.assign(hub, { getServers: () => servers })
	}

	it("should return empty array when mcpHub is undefined", () => {
		const result = getMcpServerTools(undefined)
		expect(result).toEqual([])
	})

	it("should return empty array when no servers are available", () => {
		const mockHub = createMockMcpHub([])
		const result = getMcpServerTools(mockHub as McpHub)
		expect(result).toEqual([])
	})

	it("should generate tool definitions for server tools", () => {
		const server = createMockServer("testServer", [createMockTool("testTool")])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(1)
		expect(result[0].type).toBe("function")
		expect(getFunction(result[0]).name).toBe("mcp--testServer--testTool")
		expect(getFunction(result[0]).description).toBe("Test tool")
	})

	it("should filter out tools with enabledForPrompt set to false", () => {
		const enabledTool = createMockTool("enabledTool")
		const disabledTool = { ...createMockTool("disabledTool"), enabledForPrompt: false }
		const server = createMockServer("testServer", [enabledTool, disabledTool])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(1)
		expect(getFunction(result[0]).name).toBe("mcp--testServer--enabledTool")
	})

	it("should deduplicate tools when same server exists in both global and project configs", () => {
		const projectServer = createMockServer(
			"context7",
			[createMockTool("resolve-library-id", "Project description")],
			"project",
		)

		// McpHub.getServers() deduplicates with project servers taking priority
		// This test simulates the deduplicated result (only project server returned)
		const mockHub = createMockMcpHub([projectServer])

		const result = getMcpServerTools(mockHub as McpHub)

		// Should only have one tool (from project server)
		expect(result).toHaveLength(1)
		expect(getFunction(result[0]).name).toBe("mcp--context7--resolve-library-id")
		// Project server takes priority
		expect(getFunction(result[0]).description).toBe("Project description")
	})

	it("should allow tools with different names from the same server", () => {
		const server = createMockServer("testServer", [
			createMockTool("tool1"),
			createMockTool("tool2"),
			createMockTool("tool3"),
		])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(3)
		const toolNames = result.map((t) => getFunction(t).name)
		expect(toolNames).toContain("mcp--testServer--tool1")
		expect(toolNames).toContain("mcp--testServer--tool2")
		expect(toolNames).toContain("mcp--testServer--tool3")
	})

	it("should allow tools with same name from different servers", () => {
		const server1 = createMockServer("server1", [createMockTool("commonTool")])
		const server2 = createMockServer("server2", [createMockTool("commonTool")])
		const mockHub = createMockMcpHub([server1, server2])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(2)
		const toolNames = result.map((t) => getFunction(t).name)
		expect(toolNames).toContain("mcp--server1--commonTool")
		expect(toolNames).toContain("mcp--server2--commonTool")
	})

	it("should skip servers without tools", () => {
		const serverWithTools = createMockServer("withTools", [createMockTool("tool1")])
		const serverWithoutTools = createMockServer("withoutTools", [])
		const serverWithUndefinedTools: McpServer = {
			...createMockServer("undefinedTools", []),
			tools: undefined,
		}
		const mockHub = createMockMcpHub([serverWithTools, serverWithoutTools, serverWithUndefinedTools])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(1)
		expect(getFunction(result[0]).name).toBe("mcp--withTools--tool1")
	})

	it("should include required fields from tool schema", () => {
		const toolWithRequired: McpTool = {
			name: "toolWithRequired",
			description: "Tool with required fields",
			inputSchema: {
				type: "object",
				properties: {
					requiredField: { type: "string" },
					optionalField: { type: "number" },
				},
				required: ["requiredField"],
			},
		}
		const server = createMockServer("testServer", [toolWithRequired])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(1)
		// additionalProperties: false should only be on the root object type, not on primitive types
		expect(getFunction(result[0]).parameters).toEqual({
			type: "object",
			properties: {
				requiredField: { type: "string" },
				optionalField: { type: "number" },
			},
			additionalProperties: false,
			required: ["requiredField"],
		})
	})

	it("should not include required field when schema has no required fields", () => {
		const toolWithoutRequired: McpTool = {
			name: "toolWithoutRequired",
			description: "Tool without required fields",
			inputSchema: {
				type: "object",
				properties: {
					optionalField: { type: "string" },
				},
			},
		}
		const server = createMockServer("testServer", [toolWithoutRequired])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result).toHaveLength(1)
		// additionalProperties: false should only be on the root object type, not on primitive types
		expect(getFunction(result[0]).parameters).toEqual({
			type: "object",
			properties: {
				optionalField: { type: "string" },
			},
			additionalProperties: false,
		})
		expect(getFunction(result[0]).parameters).not.toHaveProperty("required")
	})
	describe("allowedServers filtering", () => {
		it("should return all tools when allowedServers is undefined", () => {
			const server1 = createMockServer("server1", [createMockTool("tool1")])
			const server2 = createMockServer("server2", [createMockTool("tool2")])
			const mockHub = createMockMcpHub([server1, server2])

			const result = getMcpServerTools(mockHub as McpHub, undefined)

			expect(result).toHaveLength(2)
			const toolNames = result.map((t) => getFunction(t).name)
			expect(toolNames).toContain("mcp--server1--tool1")
			expect(toolNames).toContain("mcp--server2--tool2")
		})

		it("should return only tools from allowed servers when allowedServers is provided", () => {
			const server1 = createMockServer("server1", [createMockTool("tool1")])
			const server2 = createMockServer("server2", [createMockTool("tool2")])
			const server3 = createMockServer("server3", [createMockTool("tool3")])
			const mockHub = createMockMcpHub([server1, server2, server3])

			const result = getMcpServerTools(mockHub as McpHub, ["server1", "server3"])

			expect(result).toHaveLength(2)
			const toolNames = result.map((t) => getFunction(t).name)
			expect(toolNames).toContain("mcp--server1--tool1")
			expect(toolNames).toContain("mcp--server3--tool3")
			expect(toolNames).not.toContain("mcp--server2--tool2")
		})

		it("should return empty array when allowedServers is empty array", () => {
			const server1 = createMockServer("server1", [createMockTool("tool1")])
			const server2 = createMockServer("server2", [createMockTool("tool2")])
			const mockHub = createMockMcpHub([server1, server2])

			const result = getMcpServerTools(mockHub as McpHub, [])

			expect(result).toEqual([])
		})

		it("should ignore server names in allowedServers not found in hub", () => {
			const server1 = createMockServer("server1", [createMockTool("tool1")])
			const mockHub = createMockMcpHub([server1])

			const result = getMcpServerTools(mockHub as McpHub, ["server1", "nonexistent-server"])

			expect(result).toHaveLength(1)
			expect(getFunction(result[0]).name).toBe("mcp--server1--tool1")
		})
	})

	it("uses hub-assigned aliases so colliding server names generate distinct tool names", () => {
		const dotted = createMockServer("svc.prod", [createMockTool("ping")])
		const literal = createMockServer("svc_prod", [createMockTool("ping")])
		const mockHub = createMockMcpHub([dotted, literal], { "svc.prod": "svc_prod_2" })

		const result = getMcpServerTools(mockHub as McpHub)

		const names = result.map((t) => getFunction(t).name)
		expect(names).toStrictEqual(["mcp--svc_prod_2--ping", "mcp--svc_prod--ping"])
	})

	it("falls back to plain sanitization through the real getServerAlias when the registry has no alias", () => {
		const server = createMockServer("svc.prod", [createMockTool("ping")])
		// Controlled registry state: no entry for "svc.prod", so the real
		// getServerAlias runs its production fallback instead of a mock that
		// repeats it.
		const hub = createRealAliasHub([server])

		const result = getMcpServerTools(hub)

		expect(result).toHaveLength(1)
		expect(getFunction(result[0]).name).toBe("mcp--svc_prod--ping")
		// Generation also bound the advertised name to its issuing server and
		// original tool, so dispatch can resolve it without the registry.
		expect(hub.findGeneratedToolBinding("mcp--svc_prod--ping")).toStrictEqual({
			serverName: "svc.prod",
			toolName: "ping",
		})
	})

	it("gives colliding tool names distinct segments and binds each to its original tool", () => {
		// "System.readFile" and "System_readFile" both sanitize to
		// System_readFile; the second must keep its own generated segment and
		// its own reverse binding, or its definition is dropped and the call
		// always executes the literal tool (thread 4680575773).
		const server = createMockServer("server", [
			createMockTool("System.readFile"),
			createMockTool("System_readFile"),
		])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		const names = result.map((t) => getFunction(t).name)
		expect(names).toStrictEqual(["mcp--server--System_readFile", "mcp--server--System_readFile_2"])
		expect(mockHub.registerGeneratedToolName).toHaveBeenCalledWith(
			"mcp--server--System_readFile",
			"server",
			"System.readFile",
		)
		expect(mockHub.registerGeneratedToolName).toHaveBeenCalledWith(
			"mcp--server--System_readFile_2",
			"server",
			"System_readFile",
		)
	})

	it("reuses the same segment when the same original tool name repeats", () => {
		const server = createMockServer("server", [createMockTool("tool"), createMockTool("tool")])
		const mockHub = createMockMcpHub([server])

		const result = getMcpServerTools(mockHub as McpHub)

		expect(result.map((t) => getFunction(t).name)).toStrictEqual(["mcp--server--tool"])
	})
})

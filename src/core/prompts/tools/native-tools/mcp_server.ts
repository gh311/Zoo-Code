import type OpenAI from "openai"
import { McpHub } from "../../../../services/mcp/McpHub"
import { buildMcpToolName, nextServerAlias, sanitizeMcpName } from "../../../../utils/mcp-name"
import { normalizeToolSchema, type JsonSchema } from "../../../../utils/json-schema"

/**
 * Dynamically generates native tool definitions for all enabled tools across connected MCP servers.
 * Tools are deduplicated by name to prevent API errors. When the same server exists in both
 * global and project configs, project servers take priority (handled by McpHub.getServers()).
 *
 * Distinct original tool names that sanitize to the same segment (for example
 * "System.readFile" and "System_readFile") each keep a distinct generated
 * segment, and every generated name is bound to its issuing server and
 * original tool so dispatch cannot reach a different server or tool after a
 * later registration reclaims an alias (issue #2338 review).
 *
 * @param mcpHub The McpHub instance containing connected servers.
 * @returns An array of OpenAI.Chat.ChatCompletionTool definitions.
 */
export function getMcpServerTools(mcpHub?: McpHub, allowedServers?: string[]): OpenAI.Chat.ChatCompletionTool[] {
	if (!mcpHub) {
		return []
	}

	let servers = mcpHub.getServers()

	// Filter servers by allowlist if provided
	if (allowedServers) {
		const allowSet = new Set(allowedServers)
		servers = servers.filter((s) => allowSet.has(s.name))
	}
	const tools: OpenAI.Chat.ChatCompletionTool[] = []
	// Track seen tool names to prevent duplicates (e.g., when same server exists in both global and project configs)
	const seenToolNames = new Set<string>()

	for (const server of servers) {
		if (!server.tools) {
			continue
		}
		// Generated segments already assigned for this server, mapped to the
		// original tool name that owns them. A repeat of the same original
		// name reuses its assigned segment; a distinct original that
		// sanitizes to a taken segment moves to a suffixed segment.
		const segmentOwners = new Map<string, string>()
		// Reverse map: original tool name -> segment already assigned to it.
		// Without it, a repeated original whose base is owned by another
		// tool allocated a fresh suffix on every occurrence (thread 4683306127).
		const segmentByOriginal = new Map<string, string>()
		for (const tool of server.tools) {
			// Filter tools where tool.enabledForPrompt is not explicitly false
			if (tool.enabledForPrompt === false) {
				continue
			}

			const baseSegment = sanitizeMcpName(tool.name)
			const assignedSegment = segmentByOriginal.get(tool.name)
			const segmentOwner = segmentOwners.get(baseSegment)
			const toolSegment =
				assignedSegment ??
				// Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent mutants, when the condition is false (no owner, or the owner is this tool and the ?? above already handled the repeat) nextServerAlias returns the free base segment itself, so both branches agree.
				(segmentOwner !== undefined && segmentOwner !== tool.name
					? nextServerAlias(tool.name, new Set(segmentOwners.keys()))
					: baseSegment)
			segmentOwners.set(toolSegment, tool.name)
			segmentByOriginal.set(tool.name, toolSegment)

			// Build the tool name from the hub-assigned server alias so two
			// servers whose sanitized names collide (e.g. "svc.prod" and
			// "svc_prod") still get distinct, correctly resolvable names
			const toolName = buildMcpToolName(mcpHub.getServerAlias(server.name), toolSegment)

			// Skip duplicate tool names - first occurrence wins (project servers come before global servers)
			if (seenToolNames.has(toolName)) {
				continue
			}
			seenToolNames.add(toolName)

			// Bind the generated name to the issuing server and the original
			// tool so an exact echo of the name reaches both at dispatch.
			mcpHub.registerGeneratedToolName(toolName, server.name, tool.name)

			const originalSchema = tool.inputSchema as Record<string, unknown> | undefined

			// Normalize schema for JSON Schema 2020-12 compliance (type arrays → anyOf)
			let parameters: JsonSchema
			if (originalSchema) {
				parameters = normalizeToolSchema(originalSchema) as JsonSchema
			} else {
				// No schema provided - create a minimal valid schema
				parameters = { type: "object", additionalProperties: false } as JsonSchema
			}

			const toolDefinition: OpenAI.Chat.ChatCompletionTool = {
				type: "function",
				function: {
					name: toolName,
					description: tool.description,
					parameters: parameters as OpenAI.FunctionParameters,
				},
			}

			tools.push(toolDefinition)
		}
	}

	return tools
}

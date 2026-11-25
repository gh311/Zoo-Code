import type { ClientOptions } from "openai"

import { Agent, fetch as undiciFetch } from "undici"
import type { RequestInit as UndiciRequestInit } from "undici"

import { isProxyEnabled } from "../../../utils/networkProxy"

import { hasUsableTimeout, toSdkTimeoutMs } from "./abort-signal"

/**
 * The `fetch` the OpenAI SDK must use so the undici transport honors the
 * configured request deadline.
 *
 * The SDK `timeout` option aborts the whole request, but the transport keeps
 * its own default 300 s undici `bodyTimeout` between response chunks, so a
 * slow stream dies at 300 s even when the configured timeout is larger
 * (#1407). The undici `Agent` here aligns `bodyTimeout` and `headersTimeout`
 * with the configured value; `0` disables both transport deadlines.
 *
 * Returns `undefined` while the debug proxy is active: the proxy routes
 * undici through a global `ProxyAgent`, and an explicit dispatcher would
 * bypass it.
 */
export function createUndiciTimeoutFetch(timeoutMs: number): ClientOptions["fetch"] {
	if (isProxyEnabled()) {
		return undefined
	}

	const deadline = hasUsableTimeout(timeoutMs) ? toSdkTimeoutMs(timeoutMs) : 0
	const agent = new Agent({ bodyTimeout: deadline, headersTimeout: deadline })

	const timeoutFetch: NonNullable<ClientOptions["fetch"]> = async (input, init) =>
		(await undiciFetch(input as unknown as Parameters<typeof undiciFetch>[0], {
			...(init as unknown as UndiciRequestInit),
			dispatcher: agent,
		})) as unknown as Response

	return timeoutFetch
}

/**
 * The kernel seam.
 *
 * This is the only module in this package allowed to name an `@deepseek-ai/*`
 * module (the ecosystem's "no `@deepseek-ai/*` import outside the adapter layer"
 * packaging rule). Everything the plugin takes from the kernel crosses here, so
 * the rest of the source stays a pure consumer of the structural `ctx` contract.
 *
 * Today the seam carries one thing: the helper that builds a model-visible
 * context message. It is imported *lazily* — the plugin must not pin a kernel
 * version, the package is supplied by whichever installation resolves this
 * bundle, and a composition that cannot supply it must still work. When the
 * import or the call fails, a structurally equivalent plain message is returned
 * instead: the harness consumes these shapes structurally, never by identity.
 *
 * @module adapter/kernel.js
 */

/** Resolved lazily and cached; `null` means "the kernel does not supply it". */
let cached

/**
 * Resolve the kernel's `createUserMessage`, or `null` when unavailable.
 * @returns {Promise<((input: object) => object) | null>}
 */
async function loadCreateUserMessage() {
  if (cached !== undefined) return cached
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    cached = typeof module.createUserMessage === 'function' ? module.createUserMessage : null
  } catch {
    cached = null
  }
  return cached
}

/**
 * Build one model-visible context message carrying `text`.
 *
 * @param {string} text - the text the model should see
 * @returns {Promise<object>} a message the `tools/post-execute` seam can ferry
 */
export async function contextMessage(text) {
  const content = [{ type: 'text', text }]
  const source = { kind: 'skill-updates' }
  const create = await loadCreateUserMessage()
  if (create !== null) {
    try {
      return create({ content, source })
    } catch {
      /* an unexpected kernel signature degrades to the structural message */
    }
  }
  return { role: 'user', content, source }
}

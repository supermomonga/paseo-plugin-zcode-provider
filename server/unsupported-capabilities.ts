// Official ZCode capabilities that cannot run in the provider's standalone Server
// (ADR 19). Computer Use needs the code-signed Desktop to start its Helper, and
// only the Desktop host supplies browsers to Browser Use. Visualize (3.15.1+)
// needs Desktop's inline view host: ZCode gives its output directory only to
// Desktop-surface Agents and hides it from terminal sessions for that reason.
export const SUPPRESSED_OFFICIAL_PLUGINS = [
  "computer-use@zcode-plugins-official",
  "browser-use@zcode-plugins-official",
  "visualize@zcode-plugins-official",
] as const;

// Both capabilities run through this shared tool. Hiding it per turn covers
// runtimes without the ZCode patch, such as the PASEO_ZCODE_RUNTIME override.
export const UNSUPPORTED_TOOLS = ["mcp__node_repl__js"] as const;

// ZCode 3.18's Session tools that start or stop work in other ZCode sessions
// (ADR 31). That work runs in this provider's Server without a Paseo agent,
// so Paseo neither shows it nor counts it before releasing an idle runtime.
// Paseo's own tools create and message agents instead. The read-only tools and
// those that only rename, archive or pin a session stay available.
export const HIDDEN_SESSION_TOOLS = [
  "CreateSession",
  "ForkSession",
  "SendToSession",
  "InterruptSession",
] as const;

/** The tools hidden from the model on every turn the provider starts. */
export const TURN_TOOL_DISALLOWLIST: readonly string[] = [
  ...UNSUPPORTED_TOOLS,
  ...HIDDEN_SESSION_TOOLS,
];

export const UNSUPPORTED_CAPABILITY_ENVIRONMENT = {
  // Official switch: the Server no longer hands node_repl a Computer Use broker.
  ZCODE_CUA_PRODUCT_HELPER: "0",
  // Read by patches/zcode/0001-hide-suppressed-official-plugins.patch.
  PASEO_ZCODE_SUPPRESSED_PLUGINS: SUPPRESSED_OFFICIAL_PLUGINS.join(","),
} as const;

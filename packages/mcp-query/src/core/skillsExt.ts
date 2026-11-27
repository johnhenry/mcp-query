// Constants for the Skills extension (SEP-2640). Dependency-free so the
// connection layer can test capabilities without importing the skills client.

/** The extension id a server advertises in `capabilities.extensions`. */
export const SKILLS_EXT = "io.modelcontextprotocol/skills";

/** Minimum `@modelcontextprotocol/client` version that ships `ext/skills`. */
export const SKILLS_MIN_SDK = "2.4.0";

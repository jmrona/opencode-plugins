// Local plugin barrel. opencode's auto-discovery only scans plugins/*.{ts,js}
// (top level, no subdirectories), and its loader instantiates EVERY exported
// function of this module as a plugin. A new plugin = a new folder with its
// index.ts + config, and one line here.
//
// Note: export ONLY plugin functions — any other export breaks loading
// ("Plugin export is not a function").

export { SkillModelRouter } from "./skill-model-router"
export { TempSession } from "./temp-session"

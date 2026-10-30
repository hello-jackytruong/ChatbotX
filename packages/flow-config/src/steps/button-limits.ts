/**
 * Dependency-free button limits. Kept apart from `./button` (which pulls the
 * step schemas) so packages below flow-config — the database partials — can
 * read them through `@chatbotx.io/flow-config/button-limits` without loading
 * the whole flow schema graph.
 */
export const BUTTON_LABEL_MAX = 20

/**
 * Longest number a Call Phone Number button may be authored with. E.164 is
 * `+` plus at most 15 digits.
 */
export const PHONE_NUMBER_LITERAL_MAX = 16

/**
 * Longest authored value that contains a `{{variable}}`. Variable tokens
 * (`{{bot_field:<id>}}`) are far longer than the number they resolve to, so
 * only the resolved value is validated as a number, at send time.
 */
export const PHONE_NUMBER_EXPRESSION_MAX = 100

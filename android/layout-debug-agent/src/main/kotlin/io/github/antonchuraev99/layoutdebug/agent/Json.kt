package io.github.antonchuraev99.layoutdebug.agent

/** Just enough JSON writing for the agent's answers; no JSON library in the app's debug build. */
internal object Json {

    fun string(value: String): String = StringBuilder().appendJsonString(value).toString()

    /** `{"error":"..."}` */
    fun error(message: String): String = "{\"error\":${string(message)}}"
}

internal fun StringBuilder.appendJsonString(value: String): StringBuilder {
    append('"')
    for (ch in value) {
        when (ch) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (ch < ' ' || ch == ' ' || ch == ' ') {
                append("\\u").append(ch.code.toString(16).padStart(4, '0'))
            } else {
                append(ch)
            }
        }
    }
    append('"')
    return this
}

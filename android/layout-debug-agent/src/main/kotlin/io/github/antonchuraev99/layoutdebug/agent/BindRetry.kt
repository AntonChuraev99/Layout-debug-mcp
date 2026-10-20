package io.github.antonchuraev99.layoutdebug.agent

/** How often a failed bind is tried again while the app is in the foreground. */
internal const val BIND_RETRY_MS = 3_000L

/**
 * When to try binding the agent's port again, and when that is worth a log line.
 *
 * The port is often held by another debug app with the agent. Once that app is closed the
 * port frees up, so the agent keeps trying every [BIND_RETRY_MS], but only while this app is
 * in the foreground (nobody captures a background app). The log gets one line per change of
 * state, not one per attempt. Pure; the server thread drives it.
 */
internal class BindRetry {

    private var failure: String? = null

    /** Whether to attempt a bind now: always the first time, then only in the foreground. */
    fun shouldAttempt(inForeground: Boolean): Boolean = failure == null || inForeground

    /** A bind failed with [reason]; true when this is news (first failure or another reason). */
    fun failed(reason: String): Boolean {
        val news = reason != failure
        failure = reason
        return news
    }

    /** The bind worked; true when it follows failures (so the recovery is logged). */
    fun bound(): Boolean {
        val recovered = failure != null
        failure = null
        return recovered
    }
}

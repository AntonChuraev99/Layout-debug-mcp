package io.github.antonchuraev99.layoutdebug.agent

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

internal const val TAG = "layout-debug"

/** How long an HTTP thread waits for the main thread before giving up. */
internal const val MAIN_TIMEOUT_MS = 3_000L

private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

/**
 * Runs [block] on the main thread and waits for it: Compose state must be read and written
 * there, and the HTTP threads are not it. See [runWithDeadline] for what a timeout means.
 */
internal fun <T> onMain(block: () -> T): Result<T> {
    if (Looper.myLooper() == Looper.getMainLooper()) return runCatching(block)
    return runWithDeadline(
        post = { mainHandler.post(it) },
        cancel = { mainHandler.removeCallbacks(it) },
        timeoutMs = MAIN_TIMEOUT_MS,
        block = block,
    )
}

/**
 * Hands [block] to another thread through [post] and waits up to [timeoutMs] for it.
 *
 * A timeout must not turn into a late side effect: when the caller gives up before the block
 * started, the block is withdrawn ([cancel]) and, should it still be dequeued, skipped, so a
 * live edit reported as failed never lands on the device afterwards. When the block already
 * started, its real outcome is awaited (up to another [timeoutMs]) and returned, because it is
 * what happened. Pure: [post] and [cancel] are injected; exported for tests.
 */
internal fun <T> runWithDeadline(
    post: (Runnable) -> Unit,
    cancel: (Runnable) -> Unit,
    timeoutMs: Long,
    block: () -> T,
): Result<T> {
    val claimed = AtomicBoolean(false)
    val done = CountDownLatch(1)
    var result: Result<T>? = null
    val task = Runnable {
        if (!claimed.compareAndSet(false, true)) return@Runnable
        result = runCatching(block)
        done.countDown()
    }
    post(task)
    if (done.await(timeoutMs, TimeUnit.MILLISECONDS)) return result!!
    if (claimed.compareAndSet(false, true)) {
        cancel(task)
        return Result.failure(TimeoutException("the main thread did not answer within $timeoutMs ms; nothing was changed"))
    }
    // The block is running right now: its outcome is the truth.
    if (done.await(timeoutMs, TimeUnit.MILLISECONDS)) return result!!
    return Result.failure(TimeoutException("the main thread is still busy with this request after ${2 * timeoutMs} ms"))
}

/** Logcat only: a developer tool must not reach the app's crash reporter. */
internal fun log(message: String) {
    Log.i(TAG, message)
}

internal fun logError(message: String) {
    Log.e(TAG, message)
}

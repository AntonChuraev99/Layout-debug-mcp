package io.github.antonchuraev99.layoutdebug.agent

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

internal const val TAG = "layout-debug"

/** How long an HTTP thread waits for the main thread (or PixelCopy) before giving up. */
internal const val MAIN_TIMEOUT_SECONDS = 3L

private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

/**
 * Runs [block] on the main thread and waits for it: Compose state must be read and written
 * there, and the HTTP threads are not it. A failure or a main thread that does not answer
 * within [MAIN_TIMEOUT_SECONDS] comes back as a failed Result with the reason.
 */
internal fun <T> onMain(block: () -> T): Result<T> {
    if (Looper.myLooper() == Looper.getMainLooper()) return runCatching(block)
    var result: Result<T> = Result.failure(TimeoutException("the main thread did not answer within $MAIN_TIMEOUT_SECONDS s"))
    val latch = CountDownLatch(1)
    mainHandler.post {
        result = runCatching(block)
        latch.countDown()
    }
    latch.await(MAIN_TIMEOUT_SECONDS, TimeUnit.SECONDS)
    return result
}

/** Logcat only: a developer tool must not reach the app's crash reporter. */
internal fun log(message: String) {
    Log.i(TAG, message)
}

internal fun logError(message: String) {
    Log.e(TAG, message)
}

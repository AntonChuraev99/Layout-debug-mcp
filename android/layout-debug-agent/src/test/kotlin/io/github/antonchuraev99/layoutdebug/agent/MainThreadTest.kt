package io.github.antonchuraev99.layoutdebug.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class MainThreadTest {

    @Test
    fun `a block that runs in time returns its value`() {
        val result = runWithDeadline({ Thread(it).start() }, {}, 1_000) { 42 }
        assertEquals(42, result.getOrThrow())
    }

    @Test
    fun `a timed-out block is withdrawn and never runs later`() {
        var queued: Runnable? = null
        var cancelled: Runnable? = null
        var ran = false
        val result = runWithDeadline({ queued = it }, { cancelled = it }, 50) { ran = true }

        assertTrue(result.exceptionOrNull() is TimeoutException)
        assertTrue(cancelled === queued)
        // The main thread gets to the queue anyway (removeCallbacks lost the race): still skipped.
        queued!!.run()
        assertFalse(ran)
    }

    @Test
    fun `a block that already started is awaited, and its real outcome is returned`() {
        val started = CountDownLatch(1)
        val result = runWithDeadline({ r -> Thread(r).start() }, {}, 100) {
            started.countDown()
            Thread.sleep(150)
            "applied"
        }
        assertTrue(started.await(0, TimeUnit.MILLISECONDS))
        assertEquals("applied", result.getOrThrow())
    }

    @Test
    fun `a failing block reports its own error`() {
        val result = runWithDeadline({ Thread(it).start() }, {}, 1_000) { error("boom") }
        assertEquals("boom", result.exceptionOrNull()?.message)
    }
}

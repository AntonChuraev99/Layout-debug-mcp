package com.example.layoutdebug.sample

import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.antonchuraev99.layoutdebug.LayoutDebug
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The agent end to end inside the sample, on whatever Compose line the build uses
 * (`-PcomposeBom`): the server is up, `/tree` has the lazy-list items with their source and
 * text, and a live edit moves one of them by exactly the requested offset, then resets.
 * This is the compatibility check the README table is built from.
 */
@RunWith(AndroidJUnit4::class)
class AgentSmokeTest {

    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    private val args = InstrumentationRegistry.getArguments()
    private val port = args.getString("layoutDebugPort")?.toIntOrNull() ?: 8790

    @Test
    fun treeHasTheListAndAnOverrideMovesARow() {
        waitFor("the agent to listen") { LayoutDebug.isRunning }

        val health = JSONObject(get("/health"))
        assertTrue(health.getBoolean("ok"))
        args.getString("expectedComposeUi")?.let { expected ->
            assertEquals("Compose UI version the sample runs on", expected, health.optString("compose"))
        }

        val tree = waitForTree { nodes -> nodes.values().any { it.optString("kind") == "RowCard" } }
        val card = tree.values().first { it.optString("kind") == "RowCard" && it.getBoolean("movable") }
        assertTrue("RowCard comes from the sample's code", card.getJSONObject("source").getString("file") == "MainActivity.kt")
        assertNotNull("a Text carries its string", tree.values().firstOrNull { it.optString("text") == "Row 1" })
        // SaveCard: Card { Text("Save", padding) } is one box; the node it folds into keeps the text.
        assertNotNull("the folded Card keeps its Text's string", tree.values().firstOrNull { it.optString("text") == "Save" })
        val id = card.getString("id")
        val y = card.getJSONObject("bounds").getInt("y")

        val applied = JSONObject(get("/override?id=$id&dx=0&dy=60&w=-1&h=-1"))
        assertTrue("override answer: $applied", applied.optBoolean("ok"))
        val moved = waitForTree { nodes -> nodes.optJSONObject(id)?.getJSONObject("bounds")?.getInt("y") == y + 60 }
        assertEquals(y + 60, moved.getJSONObject(id).getJSONObject("bounds").getInt("y"))

        val cleared = JSONObject(get("/overrides/clear"))
        assertTrue("clear answer: $cleared", cleared.optBoolean("ok"))
        waitForTree { nodes -> nodes.optJSONObject(id)?.getJSONObject("bounds")?.getInt("y") == y }
    }

    /**
     * After a scroll the list composes the next items ahead (prefetch) without placing them;
     * ui-tooling reports those at the window's (0, 0): (0, 0) of the frame on an edge-to-edge
     * screen, above it (negative y) when the content starts below the status bar. List content
     * always has a start padding, so a list node at x <= 0 and y <= 0 is such a ghost.
     */
    @Test
    fun itemsComposedAheadAreNotInTheTree() {
        waitFor("the agent to listen") { LayoutDebug.isRunning }
        waitForTree { nodes -> nodes.values().any { it.optString("kind") == "RowCard" } }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val metrics = instrumentation.targetContext.resources.displayMetrics
        val x = metrics.widthPixels / 2
        instrumentation.uiAutomation
            .executeShellCommand("input swipe $x ${metrics.heightPixels * 3 / 4} $x ${metrics.heightPixels / 2} 400")
            .close()
        // The swipe runs in another process: wait until the list has moved and settled.
        val start = System.currentTimeMillis()
        val scrolled = waitForStableTree { nodes -> nodes.values().none { it.optString("text") == "Row 1" && it.getJSONObject("bounds").getInt("y") > metrics.heightPixels / 4 } || System.currentTimeMillis() - start > 3_000 }

        val ghosts = scrolled.values().filter {
            val b = it.getJSONObject("bounds")
            it.optJSONObject("source")?.optString("file") == "MainActivity.kt" &&
                it.optString("kind") in setOf("RowCard", "SaveCard", "Row", "Column", "Box", "Text") &&
                b.getInt("x") <= 0 && b.getInt("y") <= 0
        }
        assertTrue("unplaced list nodes at the window origin: ${ghosts.map { it.optString("label") }}", ghosts.isEmpty())
    }

    /**
     * `/tree` once [moved] holds and two captures in a row have the same boxes: a scroll that
     * has stopped, without guessing how long a fling takes.
     */
    private fun waitForStableTree(moved: (JSONObject) -> Boolean): JSONObject {
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        var previous: String? = null
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val nodes = waitForTree { true }
            val boxes = nodes.keys().asSequence().sorted().joinToString { "$it=${nodes.getJSONObject(it).getJSONObject("bounds")}" }
            if (moved(nodes) && boxes == previous) return nodes
            previous = boxes
            Thread.sleep(200)
        }
        throw AssertionError("the tree did not settle after the scroll")
    }

    /** `/tree` until [ready] holds (a frame after a live edit can lag one capture), as id → node. */
    private fun waitForTree(ready: (JSONObject) -> Boolean): JSONObject {
        var last: String? = null
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val body = get("/tree")
            last = body
            val json = JSONObject(body)
            if (!json.has("error")) {
                val nodes = json.getJSONObject("nodes")
                if (ready(nodes)) return nodes
            }
            Thread.sleep(250)
        }
        throw AssertionError("/tree never matched; last answer: ${last?.take(600)}")
    }

    private fun waitFor(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("timed out waiting for $what")
            Thread.sleep(100)
        }
    }

    /**
     * A plain HTTP GET over a socket, the way the desktop tool reaches the agent through
     * `adb forward`. A raw socket, because the app's network security config forbids cleartext
     * HTTP for HttpURLConnection, and the agent is not the app's networking.
     */
    private fun get(path: String): String = Socket().use { socket ->
        socket.connect(InetSocketAddress("127.0.0.1", port), 3_000)
        socket.soTimeout = 8_000
        val request = "GET $path HTTP/1.1\r\nHost: 127.0.0.1:$port\r\nConnection: close\r\n\r\n"
        socket.getOutputStream().apply { write(request.toByteArray()); flush() }
        val response = socket.getInputStream().readBytes().toString(Charsets.UTF_8)
        val status = response.substringBefore("\r\n")
        assertTrue("$path answered $status", status.contains(" 200 "))
        response.substringAfter("\r\n\r\n")
    }

    private fun JSONObject.values(): List<JSONObject> = keys().asSequence().map { getJSONObject(it) }.toList()
}

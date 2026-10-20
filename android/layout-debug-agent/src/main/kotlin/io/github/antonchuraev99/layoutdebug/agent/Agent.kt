package io.github.antonchuraev99.layoutdebug.agent

import android.app.Activity
import android.app.Application
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Process
import androidx.compose.ui.platform.isDebugInspectorInfoEnabled
import java.io.BufferedInputStream
import java.lang.ref.WeakReference
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** The port the desktop tool expects by default (`LD_ANDROID_PORT`). */
internal const val DEFAULT_PORT = 8790

/** Application `<meta-data>` that moves the agent to another port. */
internal const val PORT_META_DATA = "io.github.antonchuraev99.layoutdebug.PORT"

internal const val AGENT_VERSION = "0.1.0"

private const val BACKLOG = 16
private const val WORKERS = 4
private const val CLIENT_TIMEOUT_MS = 5_000

/**
 * The on-device agent: a loopback HTTP server the desktop tool reaches through
 * `adb forward tcp:8790 tcp:8790`.
 *
 * Routes (`src/server/android.ts` depends on them as they are): `/tree`, `/screenshot`,
 * `/override?id=&dx=&dy=&w=&h=`, `/overrides/clear`, and `/health` →
 * `{"ok":true,"port":8790,"package":"…","pid":…,"version":"…"}`.
 */
internal object Agent {

    private val installed = AtomicBoolean(false)

    @Volatile
    var running: Boolean = false
        private set

    @Volatile
    private var resumed: WeakReference<Activity>? = null

    private var port: Int = DEFAULT_PORT
    private var packageName: String? = null
    private lateinit var workers: ExecutorService

    val current: Activity? get() = resumed?.get()

    fun install(app: Application) {
        if (Build.FINGERPRINT == "robolectric") {
            // Unit tests instantiate the startup provider too: no socket on the developer machine.
            return
        }
        if (app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
            logError(
                "not started: ${app.packageName} is not a debuggable build. Add layout-debug-agent with " +
                    "debugImplementation and layout-debug-noop with releaseImplementation.",
            )
            return
        }
        if (!installed.compareAndSet(false, true)) return

        // Before anything is composed: every ComposeView then keeps its slot tables for us,
        // subcompositions included (see TreeCapture).
        isDebugInspectorInfoEnabled = true

        packageName = app.packageName
        port = configuredPort(app)
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                resumed = WeakReference(activity)
            }

            override fun onActivityPaused(activity: Activity) {
                if (resumed?.get() === activity) resumed = null
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityStarted(activity: Activity) = Unit
            override fun onActivityStopped(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        workers = Executors.newFixedThreadPool(WORKERS) { r ->
            Thread(r, "layout-debug-http").apply { isDaemon = true }
        }
        Thread(::serve, "layout-debug-agent").apply { isDaemon = true }.start()
    }

    private fun configuredPort(app: Application): Int {
        val fromMeta = runCatching {
            @Suppress("DEPRECATION")
            app.packageManager.getApplicationInfo(app.packageName, PackageManager.GET_META_DATA)
                .metaData?.get(PORT_META_DATA)
        }.getOrNull() ?: return DEFAULT_PORT
        val value = fromMeta.toString().toIntOrNull()
        if (value == null || value !in 1..65535) {
            logError("ignoring <meta-data $PORT_META_DATA=\"$fromMeta\">: not a port number; using $DEFAULT_PORT")
            return DEFAULT_PORT
        }
        return value
    }

    private fun serve() {
        // Loopback only: `adb forward` reaches it, other machines on the Wi-Fi network do not.
        // IPv4 by address: getLoopbackAddress() may give ::1, and adbd connects to 127.0.0.1 first.
        val loopback = InetAddress.getByAddress("localhost", byteArrayOf(127, 0, 0, 1))
        val socket = runCatching { ServerSocket(port, BACKLOG, loopback) }
            .getOrElse {
                logError(
                    "could not listen on 127.0.0.1:$port (${it.message}). Another debug app with the " +
                        "agent may hold the port: close it, or set <meta-data $PORT_META_DATA> and LD_ANDROID_PORT.",
                )
                return
            }
        running = true
        log(
            "agent $AGENT_VERSION of $packageName (pid ${Process.myPid()}) listening on " +
                "127.0.0.1:$port; on the computer: adb forward tcp:$port tcp:$port",
        )
        while (!socket.isClosed) {
            val client = runCatching { socket.accept() }
                .onFailure { logError("accept failed: ${it.message}") }
                .getOrNull() ?: continue
            workers.execute {
                runCatching { handle(client) }.onFailure { logError("request failed: ${it.message}") }
                runCatching { client.close() }
            }
        }
        running = false
    }

    private fun handle(client: Socket) {
        client.soTimeout = CLIENT_TIMEOUT_MS
        val out = client.getOutputStream()
        val head = Http.readHead(BufferedInputStream(client.getInputStream()))
        val request = head?.let(Http::parseHead)
        if (request == null) {
            Http.respondJson(out, Json.error("malformed HTTP request"), "400 Bad Request")
            return
        }
        Http.rejectReason(request)?.let { reason ->
            Http.respondJson(out, Json.error(reason), "403 Forbidden")
            return
        }
        when (request.route) {
            "/tree" -> Http.respondJson(out, captureTree())
            "/screenshot" -> when (val shot = ScreenCapture.screenshot(current)) {
                is ScreenCapture.Shot.Png -> Http.respond(out, "200 OK", "image/png", shot.bytes)
                is ScreenCapture.Shot.Failed -> Http.respondJson(out, Json.error(shot.reason), "503 Service Unavailable")
            }
            "/override" -> Http.respondJson(out, onActivity { activity ->
                LiveOverrides.applyOverride(request.query, density(activity))
            })
            "/overrides/clear" -> Http.respondJson(out, onMain { LiveOverrides.clear() }.getOrElse { Json.error(it.message ?: "clear failed") })
            "/health" -> Http.respondJson(out, health())
            else -> Http.respondJson(out, Json.error("unknown route ${request.route.take(80)}"), "404 Not Found")
        }
    }

    private fun captureTree(): String = onActivity { activity ->
        val result = TreeCapture.capture(activity) { w, h ->
            TreeMeta(density(activity), w, h, packageName, Process.myPid())
        }
        if (result.nodes.isNotEmpty()) LiveOverrides.onCaptured(result.nodes, density(activity))
        result.json
    }

    /** Runs [block] on the main thread against the resumed activity; an error JSON otherwise. */
    private fun onActivity(block: (Activity) -> String): String {
        val activity = current ?: return Json.error("no resumed activity: bring the app to the foreground")
        return onMain { block(activity) }.getOrElse { Json.error(it.message ?: it.javaClass.simpleName) }
    }

    private fun density(activity: Activity): Float = activity.resources.displayMetrics.density

    private fun health(): String = buildString {
        append("{\"ok\":true,\"port\":").append(port)
        packageName?.let { append(",\"package\":").appendJsonString(it) }
        append(",\"pid\":").append(Process.myPid())
        append(",\"version\":").appendJsonString(AGENT_VERSION)
        append('}')
    }
}

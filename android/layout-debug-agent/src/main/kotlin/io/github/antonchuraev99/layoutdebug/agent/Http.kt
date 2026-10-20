package io.github.antonchuraev99.layoutdebug.agent

import java.io.InputStream
import java.io.OutputStream
import java.net.URLDecoder

/** A parsed HTTP/1.1 request head: what the routes need, nothing more. */
internal class HttpRequest(
    val method: String,
    val target: String,
    /** Header names lower-cased; the last value wins. */
    val headers: Map<String, String>,
) {
    val route: String get() = target.substringBefore('?')
    val query: Map<String, String> get() = Http.parseQuery(target.substringAfter('?', ""))
}

/**
 * Minimal HTTP for the agent: one request per connection, `Connection: close`. The pure
 * parts (parsing, the request guard, the response head) take plain values so they can be
 * tested on the JVM.
 */
internal object Http {

    /** A request head longer than this is not a client of ours. */
    const val MAX_HEAD_BYTES = 8 * 1024

    private val loopbackHosts = setOf("127.0.0.1", "localhost", "[::1]")

    /**
     * Reads up to and including the blank line that ends the head. Reading the whole head
     * (not just the request line) matters: closing a socket with unread input makes the
     * kernel reset the connection, and the client may lose the response with it.
     * Null when the stream ends early or the head is too long.
     */
    fun readHead(input: InputStream): String? {
        val buf = StringBuilder()
        while (buf.length < MAX_HEAD_BYTES) {
            val b = input.read()
            if (b < 0) return null
            buf.append(b.toChar())
            if (buf.endsWith("\r\n\r\n") || buf.endsWith("\n\n")) return buf.toString()
        }
        return null
    }

    /** `GET /tree HTTP/1.1` + headers → a request; null when the request line is malformed. */
    fun parseHead(head: String): HttpRequest? {
        val lines = head.split('\n').map { it.trimEnd('\r') }
        val parts = lines.firstOrNull()?.split(' ') ?: return null
        if (parts.size != 3 || !parts[2].startsWith("HTTP/") || !parts[1].startsWith("/")) return null
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val colon = line.indexOf(':')
            if (colon <= 0) continue
            headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        return HttpRequest(parts[0], parts[1], headers)
    }

    /** `a=1&b=x%20y` → map; pairs without `=` are dropped, values are URL-decoded. */
    fun parseQuery(query: String): Map<String, String> =
        query.split('&')
            .filter { it.contains('=') }
            .associate { pair ->
                val key = pair.substringBefore('=')
                val value = runCatching { URLDecoder.decode(pair.substringAfter('='), "UTF-8") }
                    .getOrDefault(pair.substringAfter('='))
                key to value
            }

    /**
     * Why this request must not be served, or null when it may. The agent is meant for the
     * desktop tool reaching it through `adb forward`, which sends neither `Origin` nor a
     * cross-site `Sec-Fetch-Site`. A web page open in a browser on the device does: those are
     * refused, so a page cannot read the screen or drive live edits. A `Host` that is not a
     * loopback name means DNS rebinding and is refused too. The port in `Host` is not checked:
     * the forwarded port on the computer may differ from the device port.
     */
    fun rejectReason(request: HttpRequest): String? {
        if (request.method != "GET") return "only GET is supported"
        val origin = request.headers["origin"]
        if (origin != null) return "requests from a web page (Origin: ${origin.take(80)}) are not served"
        val site = request.headers["sec-fetch-site"]
        if (site != null && site != "none") return "cross-site browser requests are not served"
        val host = request.headers["host"]?.let(::hostName)
        if (host != null && host !in loopbackHosts) return "Host must be a loopback address, got ${host.take(80)}"
        return null
    }

    /** `127.0.0.1:8790` → `127.0.0.1`, `[::1]:8790` → `[::1]`. */
    fun hostName(hostHeader: String): String {
        val h = hostHeader.trim().lowercase()
        if (h.startsWith("[")) return h.substringBefore(']') + "]"
        return h.substringBefore(':')
    }

    fun responseHead(status: String, contentType: String, length: Int): String = buildString {
        append("HTTP/1.1 ").append(status).append("\r\n")
        append("Content-Type: ").append(contentType).append("\r\n")
        append("Content-Length: ").append(length).append("\r\n")
        append("Cache-Control: no-store\r\n")
        append("Connection: close\r\n\r\n")
    }

    fun respond(out: OutputStream, status: String, contentType: String, body: ByteArray) {
        out.write(responseHead(status, contentType, body.size).toByteArray(Charsets.US_ASCII))
        out.write(body)
        out.flush()
    }

    fun respondJson(out: OutputStream, body: String, status: String = "200 OK") =
        respond(out, status, "application/json; charset=utf-8", body.toByteArray(Charsets.UTF_8))
}

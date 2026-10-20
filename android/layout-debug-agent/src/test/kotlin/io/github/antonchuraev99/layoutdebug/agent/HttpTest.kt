package io.github.antonchuraev99.layoutdebug.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream

class HttpTest {

    private fun request(vararg headers: String, line: String = "GET /tree HTTP/1.1"): HttpRequest =
        Http.parseHead((listOf(line) + headers).joinToString("\r\n") + "\r\n\r\n")!!

    @Test
    fun `parses route, query and lower-cased headers`() {
        val r = request("Host: 127.0.0.1:8790", "Sec-Fetch-Mode: cors", line = "GET /override?id=L12&dx=-4&dy=10&w=-1&h=-1 HTTP/1.1")
        assertEquals("GET", r.method)
        assertEquals("/override", r.route)
        assertEquals(mapOf("id" to "L12", "dx" to "-4", "dy" to "10", "w" to "-1", "h" to "-1"), r.query)
        assertEquals("127.0.0.1:8790", r.headers["host"])
        assertEquals("cors", r.headers["sec-fetch-mode"])
    }

    @Test
    fun `query values are url-decoded and pairs without a value are dropped`() {
        assertEquals(mapOf("id" to "root.0 1"), Http.parseQuery("id=root.0%201&flag"))
    }

    @Test
    fun `malformed request lines are rejected`() {
        assertNull(Http.parseHead("hello\r\n\r\n"))
        assertNull(Http.parseHead("GET tree HTTP/1.1\r\n\r\n"))
        assertNull(Http.parseHead("GET /tree\r\n\r\n"))
    }

    @Test
    fun `the desktop tool request is served`() {
        // What Node's fetch sends through adb forward: no Origin, no Sec-Fetch-Site.
        assertNull(Http.rejectReason(request("Host: 127.0.0.1:8790", "sec-fetch-mode: cors", "user-agent: node")))
        assertNull(Http.rejectReason(request("Host: localhost:9000")))
        assertNull(Http.rejectReason(request("Host: [::1]:8790")))
        // A person typing the address into the device browser.
        assertNull(Http.rejectReason(request("Host: 127.0.0.1:8790", "Sec-Fetch-Site: none")))
    }

    @Test
    fun `browser pages and rebinding hosts are refused`() {
        assertNotNull(Http.rejectReason(request("Host: 127.0.0.1:8790", "Origin: https://example.com")))
        assertNotNull(Http.rejectReason(request("Host: 127.0.0.1:8790", "Sec-Fetch-Site: cross-site")))
        assertNotNull(Http.rejectReason(request("Host: attacker.example:8790")))
        assertNotNull(Http.rejectReason(request("Host: 127.0.0.1:8790", line = "POST /overrides/clear HTTP/1.1")))
    }

    @Test
    fun `head is read up to the blank line and no further`() {
        val input = ByteArrayInputStream("GET /health HTTP/1.1\r\nHost: x\r\n\r\nBODY".toByteArray())
        assertEquals("GET /health HTTP/1.1\r\nHost: x\r\n\r\n", Http.readHead(input))
        assertEquals('B'.code, input.read())
    }

    @Test
    fun `an endless or truncated head gives null`() {
        assertNull(Http.readHead(ByteArrayInputStream("GET / HTTP/1.1\r\nHost: x".toByteArray())))
        assertNull(Http.readHead(ByteArrayInputStream(ByteArray(Http.MAX_HEAD_BYTES + 10) { 'a'.code.toByte() })))
    }

    @Test
    fun `bind retry tries first always, then only in the foreground, and logs once per state change`() {
        val retry = BindRetry()
        assertEquals(true, retry.shouldAttempt(inForeground = false))
        assertEquals(true, retry.failed("EADDRINUSE"))
        assertEquals(false, retry.failed("EADDRINUSE"))
        assertEquals(false, retry.shouldAttempt(inForeground = false))
        assertEquals(true, retry.shouldAttempt(inForeground = true))
        assertEquals(true, retry.failed("EACCES"))
        assertEquals(true, retry.bound())
        assertEquals(false, retry.bound())
        assertEquals(true, retry.shouldAttempt(inForeground = false))
    }

    @Test
    fun `response head carries length and closes the connection, without CORS`() {
        val head = Http.responseHead("200 OK", "image/png", 42)
        assertEquals(
            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 42\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            head,
        )
    }
}

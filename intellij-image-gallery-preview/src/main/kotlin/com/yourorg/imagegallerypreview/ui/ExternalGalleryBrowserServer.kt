package com.yourorg.imagegallerypreview.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import kotlin.math.min

internal class ExternalGalleryBrowserServer(
    private val logger: Logger,
    private val messageHandler: (String) -> Unit
) : Disposable {
    private val assetFiles = ConcurrentHashMap<String, File>()
    private val eventClients = CopyOnWriteArrayList<OutputStream>()
    private val pendingEvents = ConcurrentLinkedQueue<String>()
    private val executor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "ImageGalleryPreview-ExternalBrowser").apply {
            isDaemon = true
        }
    }
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)

    val url: String

    init {
        server.executor = executor
        server.createContext("/") { exchange -> handleStatic(exchange) }
        server.createContext("/bridge") { exchange -> handleBridge(exchange) }
        server.createContext("/events") { exchange -> handleEvents(exchange) }
        server.createContext("/asset") { exchange -> handleAsset(exchange) }
        server.start()
        url = "http://127.0.0.1:${server.address.port}/"
    }

    fun urlForAsset(file: File): String {
        val normalized = file.absoluteFile.normalize().path
        val token = tokenFor("$normalized|${file.lastModified()}|${file.length()}")
        assetFiles[token] = file.absoluteFile
        val encodedToken = URLEncoder.encode(token, StandardCharsets.UTF_8)
        val encodedName = URLEncoder.encode(file.name, StandardCharsets.UTF_8)
        return "${url}asset?token=$encodedToken&name=$encodedName"
    }

    fun send(json: String) {
        val payload = "data: $json\n\n".toByteArray(StandardCharsets.UTF_8)
        var delivered = false
        for (client in eventClients) {
            try {
                client.write(payload)
                client.flush()
                delivered = true
            } catch (_: Throwable) {
                eventClients.remove(client)
                runCatching { client.close() }
            }
        }
        if (!delivered) {
            pendingEvents += json
            while (pendingEvents.size > MAX_PENDING_EVENTS) {
                pendingEvents.poll()
            }
        }
    }

    override fun dispose() {
        runCatching { server.stop(0) }
        for (client in eventClients) {
            runCatching { client.close() }
        }
        eventClients.clear()
        pendingEvents.clear()
        assetFiles.clear()
        executor.shutdownNow()
    }

    private fun handleStatic(exchange: HttpExchange) {
        try {
            if (!exchange.requestMethod.equals("GET", ignoreCase = true) &&
                !exchange.requestMethod.equals("HEAD", ignoreCase = true)
            ) {
                exchange.sendResponseHeaders(405, -1)
                return
            }

            val path = exchange.requestURI.path.trimStart('/').ifBlank { "index.html" }
            val allowed = setOf("index.html", "gallery.css", "gallery.js", "lottie-light.min.js")
            if (path !in allowed) {
                exchange.sendResponseHeaders(404, -1)
                return
            }

            val bytes = if (path == "index.html") {
                externalIndexHtml().toByteArray(StandardCharsets.UTF_8)
            } else {
                resourceBytes(path)
            }
            exchange.responseHeaders.set("Content-Type", contentType(path))
            exchange.responseHeaders.set("Cache-Control", "no-store")
            exchange.sendResponseHeaders(200, if (exchange.requestMethod.equals("HEAD", ignoreCase = true)) -1 else bytes.size.toLong())
            if (!exchange.requestMethod.equals("HEAD", ignoreCase = true)) {
                exchange.responseBody.write(bytes)
            }
        } catch (error: Throwable) {
            logger.warn("Failed to serve external gallery UI", error)
            runCatching { exchange.sendResponseHeaders(500, -1) }
        } finally {
            exchange.close()
        }
    }

    private fun handleBridge(exchange: HttpExchange) {
        try {
            if (!exchange.requestMethod.equals("POST", ignoreCase = true)) {
                exchange.sendResponseHeaders(405, -1)
                return
            }
            val raw = exchange.requestBody.readBytes().toString(StandardCharsets.UTF_8)
            messageHandler(raw)
            exchange.sendResponseHeaders(204, -1)
        } catch (error: Throwable) {
            logger.warn("Failed to handle external gallery message", error)
            runCatching { exchange.sendResponseHeaders(500, -1) }
        } finally {
            exchange.close()
        }
    }

    private fun handleEvents(exchange: HttpExchange) {
        if (!exchange.requestMethod.equals("GET", ignoreCase = true)) {
            exchange.sendResponseHeaders(405, -1)
            exchange.close()
            return
        }

        try {
            exchange.responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8")
            exchange.responseHeaders.set("Cache-Control", "no-cache")
            exchange.responseHeaders.set("Connection", "keep-alive")
            exchange.sendResponseHeaders(200, 0)
            val stream = exchange.responseBody
            eventClients += stream
            stream.write(": connected\n\n".toByteArray(StandardCharsets.UTF_8))
            while (true) {
                val pending = pendingEvents.poll() ?: break
                stream.write("data: $pending\n\n".toByteArray(StandardCharsets.UTF_8))
            }
            stream.flush()
        } catch (error: Throwable) {
            logger.warn("Failed to open external gallery event stream", error)
            exchange.close()
        }
    }

    private fun handleAsset(exchange: HttpExchange) {
        try {
            if (!exchange.requestMethod.equals("GET", ignoreCase = true) &&
                !exchange.requestMethod.equals("HEAD", ignoreCase = true)
            ) {
                exchange.sendResponseHeaders(405, -1)
                return
            }
            val file = queryParams(exchange.requestURI.rawQuery)["token"]
                ?.let { assetFiles[it] }
                ?.takeIf { it.exists() && it.isFile }
            if (file == null) {
                exchange.sendResponseHeaders(404, -1)
                return
            }
            serveFile(exchange, file)
        } catch (error: Throwable) {
            logger.warn("Failed to serve external gallery asset", error)
            runCatching { exchange.sendResponseHeaders(500, -1) }
        } finally {
            exchange.close()
        }
    }

    private fun serveFile(exchange: HttpExchange, file: File) {
        val length = file.length()
        exchange.responseHeaders.set("Content-Type", contentType(file.name))
        exchange.responseHeaders.set("Cache-Control", "no-store")
        exchange.responseHeaders.set("Accept-Ranges", "bytes")
        if (length <= 0L) {
            exchange.sendResponseHeaders(200, 0)
            return
        }

        val range = parseRange(exchange.requestHeaders.getFirst("Range"), length)
        if (range == null && exchange.requestHeaders.getFirst("Range") != null) {
            exchange.responseHeaders.set("Content-Range", "bytes */$length")
            exchange.sendResponseHeaders(416, -1)
            return
        }

        val start = range?.first ?: 0L
        val end = range?.second ?: (length - 1L)
        val responseLength = end - start + 1L
        if (range != null) {
            exchange.responseHeaders.set("Content-Range", "bytes $start-$end/$length")
        }
        exchange.sendResponseHeaders(if (range != null) 206 else 200, if (exchange.requestMethod.equals("HEAD", ignoreCase = true)) -1 else responseLength)
        if (exchange.requestMethod.equals("HEAD", ignoreCase = true)) return

        RandomAccessFile(file, "r").use { input ->
            input.seek(start)
            val buffer = ByteArray(BUFFER_SIZE)
            var remaining = responseLength
            while (remaining > 0) {
                val read = input.read(buffer, 0, min(buffer.size.toLong(), remaining).toInt())
                if (read < 0) break
                exchange.responseBody.write(buffer, 0, read)
                remaining -= read.toLong()
            }
        }
    }

    private fun externalIndexHtml(): String {
        val bridgeScript = """
            <script>
              window.__galleryPendingHostMessages = [];
              window.__galleryDispatchHostMessage = function(payload) {
                if (window.galleryHostReceive) {
                  window.galleryHostReceive(payload);
                } else {
                  window.__galleryPendingHostMessages.push(payload);
                }
              };
              window.intellijPostMessage = function(message) {
                fetch('/bridge', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(message)
                }).catch(function(error) {
                  console.error('[gallery-web] bridge post failed', error);
                });
              };
              var galleryEvents = new EventSource('/events');
              galleryEvents.onmessage = function(event) {
                try {
                  window.__galleryDispatchHostMessage(JSON.parse(event.data));
                } catch (error) {
                  console.error('[gallery-web] invalid host event', error);
                }
              };
            </script>
        """.trimIndent()
        return resourceText("index.html").replace("</head>", "$bridgeScript\n</head>")
    }

    private fun resourceText(name: String): String {
        return String(resourceBytes(name), StandardCharsets.UTF_8)
    }

    private fun resourceBytes(name: String): ByteArray {
        return javaClass.classLoader.getResourceAsStream("gallery-web/$name").use { input ->
            requireNotNull(input) { "Missing gallery web resource: $name" }.readBytes()
        }
    }

    private fun queryParams(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) return emptyMap()
        return rawQuery.split('&')
            .mapNotNull { part ->
                val idx = part.indexOf('=')
                if (idx <= 0) return@mapNotNull null
                val key = URLDecoder.decode(part.substring(0, idx), StandardCharsets.UTF_8)
                val value = URLDecoder.decode(part.substring(idx + 1), StandardCharsets.UTF_8)
                key to value
            }
            .toMap()
    }

    private fun parseRange(raw: String?, length: Long): Pair<Long, Long>? {
        if (raw.isNullOrBlank()) return null
        val match = Regex("""bytes=(\d*)-(\d*)""").matchEntire(raw.trim()) ?: return null
        val startText = match.groupValues[1]
        val endText = match.groupValues[2]
        if (startText.isBlank() && endText.isBlank()) return null
        val start = if (startText.isBlank()) {
            val suffix = endText.toLongOrNull() ?: return null
            (length - suffix).coerceAtLeast(0L)
        } else {
            startText.toLongOrNull() ?: return null
        }
        val end = if (endText.isBlank() || startText.isBlank()) {
            length - 1L
        } else {
            endText.toLongOrNull() ?: return null
        }.coerceAtMost(length - 1L)
        if (start < 0 || start >= length || end < start) return null
        return start to end
    }

    private fun contentType(name: String): String {
        return when (name.substringAfterLast('.', "").lowercase(Locale.ROOT)) {
            "html" -> "text/html; charset=utf-8"
            "css" -> "text/css; charset=utf-8"
            "js" -> "application/javascript; charset=utf-8"
            "json" -> "application/json; charset=utf-8"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "bmp" -> "image/bmp"
            "svg" -> "image/svg+xml"
            "avif" -> "image/avif"
            "ico" -> "image/x-icon"
            "mp4", "m4v" -> "video/mp4"
            "mov" -> "video/quicktime"
            "webm" -> "video/webm"
            "mkv" -> "video/x-matroska"
            "mp3" -> "audio/mpeg"
            "wav" -> "audio/wav"
            "ogg", "opus" -> "audio/ogg"
            "flac" -> "audio/flac"
            else -> "application/octet-stream"
        }
    }

    private fun tokenFor(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    private companion object {
        private const val BUFFER_SIZE = 64 * 1024
        private const val MAX_PENDING_EVENTS = 16
    }
}

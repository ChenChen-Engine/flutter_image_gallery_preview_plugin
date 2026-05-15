package com.yourorg.imagegallerypreview.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.diagnostic.Logger
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.io.File
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
import java.util.concurrent.Executors
import kotlin.math.min

internal class LocalMediaStreamServer(private val logger: Logger) : Disposable {
    private val files = ConcurrentHashMap<String, File>()
    private val executor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "ImageGalleryPreview-MediaStream").apply {
            isDaemon = true
        }
    }
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
    private val baseUrl: String

    init {
        server.executor = executor
        server.createContext("/media") { exchange ->
            handle(exchange)
        }
        server.start()
        baseUrl = "http://127.0.0.1:${server.address.port}"
    }

    fun urlFor(file: File): String {
        val normalized = file.absoluteFile.normalize().path
        val token = tokenFor(normalized)
        files[token] = file.absoluteFile
        val encodedToken = URLEncoder.encode(token, StandardCharsets.UTF_8)
        val encodedName = URLEncoder.encode(file.name, StandardCharsets.UTF_8)
        return "$baseUrl/media?token=$encodedToken&name=$encodedName"
    }

    override fun dispose() {
        runCatching { server.stop(0) }
        executor.shutdownNow()
        files.clear()
    }

    private fun handle(exchange: HttpExchange) {
        try {
            exchange.responseHeaders.add("Access-Control-Allow-Origin", "*")
            exchange.responseHeaders.add("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            exchange.responseHeaders.add("Access-Control-Allow-Headers", "Range, Content-Type")
            exchange.responseHeaders.add("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
            exchange.responseHeaders.add("Accept-Ranges", "bytes")

            if (exchange.requestMethod.equals("OPTIONS", ignoreCase = true)) {
                exchange.sendResponseHeaders(204, -1)
                return
            }

            if (!exchange.requestMethod.equals("GET", ignoreCase = true) &&
                !exchange.requestMethod.equals("HEAD", ignoreCase = true)
            ) {
                exchange.sendResponseHeaders(405, -1)
                return
            }

            val file = queryParams(exchange.requestURI.rawQuery)["token"]
                ?.let { files[it] }
                ?.takeIf { it.exists() && it.isFile }

            if (file == null) {
                exchange.sendResponseHeaders(404, -1)
                return
            }

            serveFile(exchange, file)
        } catch (error: Throwable) {
            logger.warn("Failed to serve gallery media", error)
            runCatching { exchange.sendResponseHeaders(500, -1) }
        } finally {
            exchange.close()
        }
    }

    private fun serveFile(exchange: HttpExchange, file: File) {
        val length = file.length()
        if (length <= 0L) {
            exchange.responseHeaders.set("Content-Type", contentType(file))
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
        val partial = range != null

        exchange.responseHeaders.set("Content-Type", contentType(file))
        exchange.responseHeaders.set("Cache-Control", "no-store")
        if (partial) {
            exchange.responseHeaders.set("Content-Range", "bytes $start-$end/$length")
        }

        exchange.sendResponseHeaders(if (partial) 206 else 200, responseLength)
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

    private fun contentType(file: File): String {
        return when (file.extension.lowercase(Locale.ROOT)) {
            "mp4", "m4v" -> "video/mp4"
            "mov" -> "video/quicktime"
            "webm" -> "video/webm"
            "mkv" -> "video/x-matroska"
            "avi" -> "video/x-msvideo"
            "3gp", "3gpp" -> "video/3gpp"
            "mpeg", "mpg" -> "video/mpeg"
            "ts", "m2ts" -> "video/mp2t"
            "wmv" -> "video/x-ms-wmv"
            "flv" -> "video/x-flv"
            "mp3" -> "audio/mpeg"
            "m4a", "aac" -> "audio/aac"
            "wav" -> "audio/wav"
            "ogg", "opus" -> "audio/ogg"
            "flac" -> "audio/flac"
            "amr" -> "audio/amr"
            "mid", "midi" -> "audio/midi"
            "caf" -> "audio/x-caf"
            "wma" -> "audio/x-ms-wma"
            "aiff", "aif" -> "audio/aiff"
            "alac" -> "audio/alac"
            "mka" -> "audio/x-matroska"
            else -> "application/octet-stream"
        }
    }

    private fun tokenFor(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
    }

    private companion object {
        private const val BUFFER_SIZE = 64 * 1024
    }
}

import java.io.File
import java.math.BigInteger
import java.net.InetAddress
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.system.exitProcess

const val IS_REPEAT = 192
const val IS_FIRST = IS_REPEAT + 12
const val IS_SECOND = IS_FIRST + 12
const val IS_THIRD = IS_SECOND + 12
const val IS_LONG = IS_THIRD + 12
const val SLOTS = IS_LONG + 192
const val SPECIAL = SLOTS + 256
const val ALIGN = SPECIAL + 114
const val LENGTHS = ALIGN + 16
const val REPEATS = LENGTHS + 514
const val LITERALS = REPEATS + 514

val CARRIED = listOf("place", "network", "abuse", "prefix", "rpki", "roas")
val LINKED = setOf("place", "network", "abuse")
val BOOKS = mapOf(
    "rpki" to "rpki", "place.granularity" to "granularity", "city.timezone" to "timezones",
    "city.type" to "place_types", "operator.category" to "categories",
    "abuse.user_type" to "categories", "abuse.service" to "services",
    "abuse.evidence" to "evidence",
)

class Lzma(private val data: ByteArray, tuning: List<Int>) {
    private val context = tuning[0]
    private val position = tuning[1]
    private val matches = tuning[2]
    private val probs = IntArray(LITERALS + (0x300 shl (context + position))) { 1024 }
    private var out = ByteArray(1 shl 16)
    private var size = 0
    private var at = 5
    private var range = UInt.MAX_VALUE
    private var code = (1..4).fold(0u) { code, index -> code shl 8 or data[index].toUByte().toUInt() }

    private fun normalize() {
        if (range >= 1u shl 24) return
        range = range shl 8
        code = code shl 8 or data[at++].toUByte().toUInt()
    }

    private fun bit(index: Int): Int {
        val chance = probs[index]
        val bound = (range shr 11) * chance.toUInt()
        val result = if (code < bound) 0 else 1
        if (result == 0) {
            range = bound
            probs[index] += (2048 - chance) shr 5
        } else {
            range -= bound
            code -= bound
            probs[index] -= chance shr 5
        }
        normalize()
        return result
    }

    private fun direct(count: Int): UInt {
        var value = 0u
        repeat(count) {
            range = range shr 1
            val result = if (code >= range) 1u else 0u
            code -= range * result
            value = value shl 1 or result
            normalize()
        }
        return value
    }

    private fun tree(base: Int, count: Int): Int {
        var symbol = 1
        repeat(count) { symbol = symbol shl 1 or bit(base + symbol) }
        return symbol - (1 shl count)
    }

    private fun reversed(base: Int, count: Int): UInt {
        var symbol = 1
        var value = 0u
        for (step in 0 until count) {
            val result = bit(base + symbol)
            symbol = symbol shl 1 or result
            value = value or (result.toUInt() shl step)
        }
        return value
    }

    private fun length(base: Int, spot: Int): Int = when {
        bit(base) == 0 -> tree(base + 2 + (spot shl 3), 3)
        bit(base + 1) == 0 -> 8 + tree(base + 130 + (spot shl 3), 3)
        else -> 16 + tree(base + 258, 8)
    }

    private fun distance(span: Int): UInt {
        val slot = tree(SLOTS + (minOf(span, 3) shl 6), 6)
        if (slot < 4) return slot.toUInt()
        val count = (slot shr 1) - 1
        val base = (2 or (slot and 1)).toUInt() shl count
        if (slot < 14) return base + reversed(SPECIAL + base.toInt() - slot - 1, count)
        return base + (direct(count - 4) shl 4) + reversed(ALIGN, 4)
    }

    private fun push(value: Int) {
        if (size == out.size) out = out.copyOf(size * 2)
        out[size++] = value.toByte()
    }

    private fun back(distance: UInt) = out[size - distance.toInt() - 1].toInt() and 0xFF

    private fun literal(state: Int, recent: UInt) {
        val previous = if (size > 0) out[size - 1].toInt() and 0xFF else 0
        val spot = (size and ((1 shl position) - 1)) shl context
        val base = LITERALS + 0x300 * (spot + (previous shr (8 - context)))
        var symbol = 1
        if (state >= 7) {
            var matched = back(recent)
            while (symbol < 0x100) {
                val expected = matched shr 7 and 1
                matched = matched shl 1
                val result = bit(base + ((1 + expected) shl 8) + symbol)
                symbol = symbol shl 1 or result
                if (result != expected) break
            }
        }
        while (symbol < 0x100) symbol = symbol shl 1 or bit(base + symbol)
        push(symbol)
    }

    fun decompress(): ByteArray {
        val recent = MutableList(4) { 0u }
        var state = 0
        while (true) {
            val spot = size and ((1 shl matches) - 1)
            if (bit(state shl 4 or spot) == 0) {
                literal(state, recent[0])
                state = if (state < 4) 0 else if (state < 10) state - 3 else state - 6
                continue
            }
            val span: Int
            if (bit(IS_REPEAT + state) == 1) {
                if (bit(IS_FIRST + state) == 1) {
                    val picked = if (bit(IS_SECOND + state) == 0) 1 else 2 + bit(IS_THIRD + state)
                    recent.add(0, recent.removeAt(picked))
                } else if (bit(IS_LONG + (state shl 4 or spot)) == 0) {
                    state = if (state < 7) 9 else 11
                    push(back(recent[0]))
                    continue
                }
                span = length(REPEATS, spot)
                state = if (state < 7) 8 else 11
            } else {
                recent.removeLast()
                span = length(LENGTHS, spot)
                state = if (state < 7) 7 else 10
                recent.add(0, distance(span))
                if (recent[0] == UInt.MAX_VALUE) return out.copyOf(size)
            }
            repeat(span + 2) { push(back(recent[0])) }
        }
    }
}

class Cursor(val data: ByteArray, var at: Int) {
    fun big(): BigInteger {
        var value = BigInteger.ZERO
        var shift = 0
        while (true) {
            val octet = data[at++].toInt()
            value = value or (BigInteger.valueOf((octet and 0x7F).toLong()) shl shift)
            if (octet >= 0) return value
            shift += 7
        }
    }

    fun small() = big().toInt()
}

fun upper(values: List<BigInteger>, address: BigInteger): Int {
    var low = 0
    var high = values.size
    while (low < high) {
        val middle = (low + high) / 2
        if (values[middle] <= address) low = middle + 1 else high = middle
    }
    return low
}

class Section(private val file: ByteArray, view: Int, entry: Map<*, *>) {
    private val buffer = ByteBuffer.wrap(file).order(ByteOrder.LITTLE_ENDIAN)
    val encoding = entry["encoding"] as String
    val read = entry["read"] as String
    private val count = (entry["count"] as Long).toInt()
    private val block = (entry["block"] as Long).toInt()
    private val group = (entry["group"] as Long).toInt()
    private val tuning = (entry["lzma"] as List<*>).map { (it as Long).toInt() }
    private val fanout = block / group
    private val total = buffer.getInt(view)
    private val width = buffer.getInt(view + 4)
    private val offsets = view + 8
    private val keysAt = offsets + 4 * (total + 1)
    private val start = keysAt + total * width
    private val keys = (0 until total).map {
        BigInteger(1, file.copyOfRange(keysAt + it * width, keysAt + (it + 1) * width))
    }
    private val blocks = mutableMapOf<Int, ByteArray>()

    private fun decoded(index: Int) = blocks.getOrPut(index) {
        val from = start + buffer.getInt(offsets + 4 * index)
        Lzma(file.copyOfRange(from, start + buffer.getInt(offsets + 4 * index + 4)), tuning)
            .decompress()
    }

    private fun number(raw: ByteArray, place: Int, size: Int): Long {
        var value = 0L
        for (index in size - 1 downTo 0) {
            value = value shl 8 or (raw[1 + place * size + index].toLong() and 0xFF)
        }
        if (encoding == "fixed") return value
        val shift = 64 - 8 * size
        return value shl shift shr shift
    }

    fun value(row: Int): Long {
        val raw = decoded(row / block)
        val place = row % block
        if (encoding != "delta") return number(raw, place, raw[0].toInt())
        return (0..place).sumOf { number(raw, it, raw[0].toInt()) }
    }

    fun text(identifier: Long): String {
        if (identifier == 0L) return ""
        val groupIndex = ((identifier - 1) / group).toInt()
        val place = ((identifier - 1) % group).toInt()
        val index = groupIndex / fanout
        val cursor = Cursor(decoded(index), 0)
        val spans = List(minOf(fanout, (count - index * block + group - 1) / group) - 1) {
            cursor.small()
        }
        cursor.at += spans.take(groupIndex % fanout).sum()
        var previous = ByteArray(0)
        repeat(place + 1) {
            val shared = cursor.data[cursor.at++].toInt() and 0xFF
            val fresh = cursor.small()
            previous = previous.copyOf(shared) + cursor.data.copyOfRange(cursor.at, cursor.at + fresh)
            cursor.at += fresh
        }
        return previous.decodeToString()
    }

    private fun heads(index: Int): Pair<List<BigInteger>, List<Int>> {
        val cursor = Cursor(decoded(index), 0)
        val total = (cursor.small() + group - 1) / group
        val heads = List(total - 1) { cursor.big() }.runningFold(keys[index]) { head, gap -> head + gap }
        val spans = List(total - 1) { cursor.small() }
        return heads to spans.runningFold(cursor.at) { start, span -> start + span }
    }

    private fun values(groupIndex: Int): List<BigInteger> {
        val index = groupIndex / fanout
        val at = groupIndex % fanout
        val size = minOf(group, count - groupIndex * group)
        val (heads, starts) = heads(index)
        val cursor = Cursor(decoded(index), starts[at])
        val hostBits = if (width == 4) 0 else 64
        val networks = List(size - 1) { cursor.big() }
            .runningFold(heads[at] shr hostBits) { network, gap -> network + gap }
        if (hostBits == 0) return networks
        return networks.map { (it shl 64) or cursor.big() }
    }

    fun row(address: BigInteger): Pair<Int, Boolean>? {
        val index = upper(keys, address) - 1
        if (index < 0) return null
        val groupIndex = index * fanout + upper(heads(index).first, address) - 1
        val values = values(groupIndex)
        val spot = upper(values, address) - 1
        if (spot < 0) return null
        return groupIndex * group + spot to (values[spot] == address)
    }
}

class Json(private val text: String) {
    private var at = 0

    private fun peek(): Char {
        while (text[at] in " \t\r\n,:") at++
        return text[at]
    }

    fun value(): Any? = when (peek()) {
        '{' -> {
            at++
            val map = linkedMapOf<String, Any?>()
            while (peek() != '}') map[value() as String] = value()
            at++
            map
        }
        '[' -> {
            at++
            val list = mutableListOf<Any?>()
            while (peek() != ']') list += value()
            at++
            list
        }
        '"' -> string()
        't' -> true.also { at += 4 }
        'f' -> false.also { at += 5 }
        'n' -> null.also { at += 4 }
        else -> {
            val start = at
            while (at < text.length && text[at] in "+-.0123456789eE") at++
            val raw = text.substring(start, at)
            raw.toLongOrNull() ?: raw.toDouble()
        }
    }

    private fun string(): String = buildString {
        at++
        while (text[at] != '"') {
            val character = text[at++]
            if (character != '\\') {
                append(character)
                continue
            }
            when (val escaped = text[at++]) {
                'u' -> append(text.substring(at, at + 4).toInt(16).toChar()).also { at += 4 }
                'n' -> append('\n')
                't' -> append('\t')
                else -> append(escaped)
            }
        }
        at++
    }
}

fun quote(text: String) = buildString {
    append('"')
    for (character in text) {
        when {
            character == '"' || character == '\\' -> append('\\').append(character)
            character < ' ' -> append("\\u%04x".format(character.code))
            else -> append(character)
        }
    }
    append('"')
}

fun write(value: Any?, depth: Int = 0): String = when (value) {
    null -> "null"
    is String -> quote(value)
    is Map<*, *> if value.isEmpty() -> "{}"
    is Map<*, *> -> {
        val indent = "  ".repeat(depth + 1)
        value.entries.joinToString(",\n", "{\n", "\n${indent.drop(2)}}") {
            "$indent${quote(it.key as String)}: ${write(it.value, depth + 1)}"
        }
    }
    else -> value.toString()
}

class Plevin(path: String) {
    private val sections = sortedMapOf<String, Section>()
    private val books = mutableMapOf<String, List<String>>()
    private val tables = mutableMapOf<String, MutableList<String>>()

    init {
        val file = File(path).readBytes()
        if (file.size < 12 || !file.copyOf(8).contentEquals("PLEVIN\u0000\u0002".toByteArray())) {
            fail("$path is not a plevin 2 database")
        }
        val size = ByteBuffer.wrap(file).order(ByteOrder.LITTLE_ENDIAN).getInt(8)
        val head = Json(file.decodeToString(12, 12 + size)).value() as Map<*, *>
        for ((name, entry) in head["sections"] as Map<*, *>) {
            name as String
            entry as Map<*, *>
            sections[name] = Section(file, 12 + size + (entry["offset"] as Long).toInt(), entry)
            val parts = name.split(".")
            if (parts.size == 3 && parts[0] in setOf("col", "link")) {
                tables.getOrPut(parts[1]) { mutableListOf() } += name
            }
        }
        val vocabularies = head["vocabularies"] as Map<*, *>
        for ((field, book) in BOOKS) {
            val words = vocabularies[book] as? List<*> ?: continue
            books[field] = words.map { it as String }
        }
    }

    private fun read(name: String, section: Section, value: Long): Any? {
        val book = books[name]
        return when {
            name == "abuse.risk" -> if (value == 255L) null else value / 100.0
            name == "abuse.is_anycast" || name == "abuse.is_satellite" -> value != 0L
            book != null -> book.getOrElse(value.toInt()) { "" }
            section.read == "text" -> sections.getValue("strings").text(value)
            section.read.isEmpty() -> value
            else -> value / 10000.0
        }
    }

    private fun row(table: String, row: Int): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>()
        for (name in tables[table].orEmpty()) {
            val section = sections.getValue(name)
            val field = name.substringAfterLast('.')
            val value = section.value(row)
            when {
                name.startsWith("col.") -> out[field] = read("$table.$field", section, value)
                value != 0L -> out[field] = row(field, value.toInt() - 1)
            }
        }
        val partial = out["postal_partial"]
        val postal = out["postal"]
        if (partial is Long && postal is String) {
            out["postal_partial"] = postal.take(partial.toInt())
        }
        return out
    }

    fun lookup(text: String): Map<String, Any?>? {
        val raw = runCatching { InetAddress.ofLiteral(text).address }
            .getOrElse { fail("$text is not an address") }
        val address = BigInteger(1, raw)
        val version = if (raw.size == 4) "v4" else "v6"
        val (row, _) = sections["spine.$version"]?.row(address) ?: return null
        val hosts = sections["hosts.$version"]
        val records = sections["hosts.$version.abuse"]
        val found = if (records == null) null else hosts?.row(address)
        val override = if (found?.second == true) records!!.value(found.first) + 1 else 0L
        return answer(version, row, override)
    }

    private fun answer(version: String, row: Int, override: Long): Map<String, Any?> {
        val out = linkedMapOf<String, Any?>()
        for (name in CARRIED) {
            val column = sections["spine.$version.$name"] ?: continue
            val value = if (override != 0L && name == "abuse") override else column.value(row)
            if (name in LINKED) {
                if (value != 0L) out[name] = row(name, value.toInt() - 1)
                continue
            }
            @Suppress("UNCHECKED_CAST")
            val network = out.getOrPut("network") { linkedMapOf<String, Any?>() }
                as MutableMap<String, Any?>
            network[name] = read(name, column, value)
        }
        return out
    }
}

fun fail(reason: String): Nothing {
    System.err.println(reason)
    exitProcess(1)
}

fun main(arguments: Array<String>) {
    if (arguments.size != 2) fail("usage: plevin path address")
    println(write(Plevin(arguments[0]).lookup(arguments[1])))
}

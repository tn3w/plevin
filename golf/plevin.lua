local IS_REPEAT = 192
local IS_FIRST = IS_REPEAT + 12
local IS_SECOND = IS_FIRST + 12
local IS_THIRD = IS_SECOND + 12
local IS_LONG = IS_THIRD + 12
local SLOTS = IS_LONG + 192
local SPECIAL = SLOTS + 256
local ALIGN = SPECIAL + 114
local LENGTHS = ALIGN + 16
local REPEATS = LENGTHS + 514
local LITERALS = REPEATS + 514
local MASK = 0xFFFFFFFF

local CARRIED = {
  "place", "network", "abuse", "prefix", "rpki", "roas", "rir", "country", "since",
}
local LINKED = { place = true, network = true, abuse = true }
local BOOKS = {
  rpki = "rpki", rir = "rirs", country = "countries",
  ["place.granularity"] = "granularity", ["city.timezone"] = "timezones",
  ["city.type"] = "place_types", ["operator.category"] = "categories",
  ["abuse.user_type"] = "categories", ["abuse.service"] = "services",
  ["abuse.evidence"] = "evidence", ["abuse.threat"] = "threats",
  ["abuse.level"] = "levels",
}

local null = setmetatable({}, { __name = "null" })
local byte, unpack = string.byte, string.unpack

local function fail(reason)
  io.stderr:write(reason, "\n")
  os.exit(1)
end

local function stream(packed, tuning)
  local context, position, matches = tuning[1], tuning[2], tuning[3]
  local probs = {}
  for index = 0, LITERALS + (0x300 << (context + position)) - 1 do probs[index] = 1024 end
  local at, range, code = 6, MASK, unpack(">I4", packed, 2)
  local out, size, done, state = {}, 0, false, 0
  local recent = { 0, 0, 0, 0 }

  local function normalize()
    if range >= 0x1000000 then return end
    range = (range << 8) & MASK
    code = ((code << 8) | byte(packed, at)) & MASK
    at = at + 1
  end

  local function bit(index)
    local chance = probs[index]
    local bound = (range >> 11) * chance
    local result = 0
    if code < bound then
      range = bound
      probs[index] = chance + ((2048 - chance) >> 5)
    else
      range, code = range - bound, code - bound
      probs[index] = chance - (chance >> 5)
      result = 1
    end
    normalize()
    return result
  end

  local function direct(count)
    local value = 0
    for _ = 1, count do
      range = range >> 1
      local result = 0
      if code >= range then code, result = code - range, 1 end
      value = (value << 1) | result
      normalize()
    end
    return value
  end

  local function tree(base, count)
    local symbol = 1
    for _ = 1, count do symbol = (symbol << 1) | bit(base + symbol) end
    return symbol - (1 << count)
  end

  local function reversed(base, count)
    local symbol, value = 1, 0
    for step = 0, count - 1 do
      local result = bit(base + symbol)
      symbol = (symbol << 1) | result
      value = value | (result << step)
    end
    return value
  end

  local function length(base, spot)
    if bit(base) == 0 then return tree(base + 2 + (spot << 3), 3) end
    if bit(base + 1) == 0 then return 8 + tree(base + 130 + (spot << 3), 3) end
    return 16 + tree(base + 258, 8)
  end

  local function distance(span)
    local slot = tree(SLOTS + (math.min(span, 3) << 6), 6)
    if slot < 4 then return slot end
    local count = (slot >> 1) - 1
    local base = (2 | (slot & 1)) << count
    if slot < 14 then return base + reversed(SPECIAL + base - slot - 1, count) end
    return base + (direct(count - 4) << 4) + reversed(ALIGN, 4)
  end

  local function literal()
    local previous = out[size] or 0
    local spot = (size & ((1 << position) - 1)) << context
    local base = LITERALS + 0x300 * (spot + (previous >> (8 - context)))
    local symbol = 1
    if state >= 7 then
      local matched = out[size - recent[1]]
      while symbol < 0x100 do
        local expected = (matched >> 7) & 1
        matched = matched << 1
        local result = bit(base + ((1 + expected) << 8) + symbol)
        symbol = (symbol << 1) | result
        if result ~= expected then break end
      end
    end
    while symbol < 0x100 do symbol = (symbol << 1) | bit(base + symbol) end
    size = size + 1
    out[size] = symbol & 0xFF
    state = state < 4 and 0 or state < 10 and state - 3 or state - 6
  end

  local function rotate()
    local held = recent[2]
    if bit(IS_SECOND + state) == 1 then
      held = recent[3]
      if bit(IS_THIRD + state) == 1 then held, recent[4] = recent[4], recent[3] end
      recent[3] = recent[2]
    end
    recent[2], recent[1] = recent[1], held
  end

  local function copy(span)
    local from = size - recent[1]
    for offset = 0, span + 1 do out[size + 1 + offset] = out[from + offset] end
    size = size + span + 2
  end

  local function step()
    local spot = size & ((1 << matches) - 1)
    if bit((state << 4) | spot) == 0 then return literal() end
    if bit(IS_REPEAT + state) == 0 then
      recent[4], recent[3], recent[2] = recent[3], recent[2], recent[1]
      local span = length(LENGTHS, spot)
      state = state < 7 and 7 or 10
      recent[1] = distance(span)
      if recent[1] == MASK then done = true return end
      return copy(span)
    end
    if bit(IS_FIRST + state) == 1 then
      rotate()
    elseif bit(IS_LONG + ((state << 4) | spot)) == 0 then
      state = state < 7 and 9 or 11
      size = size + 1
      out[size] = out[size - 1 - recent[1]]
      return
    end
    local span = length(REPEATS, spot)
    state = state < 7 and 8 or 11
    copy(span)
  end

  return function(index)
    while size < index and not done do step() end
    return out[index]
  end
end

local function varint(get, at)
  local value, shift = 0, 0
  while true do
    local octet = get(at)
    value = value | ((octet & 0x7F) << shift)
    if octet < 0x80 then return value, at + 1 end
    at, shift = at + 1, shift + 7
  end
end

local function wide_varint(get, at)
  local high, low, shift = 0, 0, 0
  while true do
    local chunk = get(at) & 0x7F
    if shift < 64 then
      low = low | (chunk << shift)
      high = high | (chunk >> (64 - shift))
    else
      high = high | (chunk << (shift - 64))
    end
    if get(at) < 0x80 then return { high, low }, at + 1 end
    at, shift = at + 1, shift + 7
  end
end

local function varints(get, at, count)
  local values = {}
  for index = 1, count do values[index], at = varint(get, at) end
  return values, at
end

local function less(a, b)
  if a[1] ~= b[1] then return math.ult(a[1], b[1]) end
  return math.ult(a[2], b[2])
end

local function add(a, b)
  local low = a[2] + b[2]
  return { a[1] + b[1] + (math.ult(low, a[2]) and 1 or 0), low }
end

local function key(raw)
  local high, low = 0, 0
  for index = 1, #raw do
    high = (high << 8) | (low >> 56)
    low = (low << 8) | byte(raw, index)
  end
  return { high, low }
end

local function upper(values, address)
  local low, high = 1, #values + 1
  while low < high do
    local middle = (low + high) // 2
    if less(address, values[middle]) then high = middle else low = middle + 1 end
  end
  return low - 1
end

local function ceil(value, divisor) return (value + divisor - 1) // divisor end

local Section = {}
Section.__index = Section

local function section(view, entry)
  local total, width = unpack("<I4I4", view)
  local self = setmetatable({
    encoding = entry.encoding, read = entry.read, count = entry.count,
    block = entry.block, group = entry.group, fanout = entry.block // entry.group,
    tuning = entry.lzma, width = width, offsets = {}, keys = {}, blocks = {},
  }, Section)
  for index = 0, total do self.offsets[index] = unpack("<I4", view, 9 + 4 * index) end
  local at = 9 + 4 * (total + 1)
  for index = 1, width > 0 and total or 0 do
    self.keys[index] = key(view:sub(at, at + width - 1))
    at = at + width
  end
  self.data = view:sub(at)
  return self
end

function Section:decoded(index)
  if not self.blocks[index] then
    local packed = self.data:sub(self.offsets[index] + 1, self.offsets[index + 1])
    self.blocks[index] = stream(packed, self.tuning)
  end
  return self.blocks[index]
end

function Section:number(get, place, width)
  local start, value = 1 + place * width, 0
  for index = width, 1, -1 do value = (value << 8) | get(start + index) end
  local signed = self.encoding == "signed" or self.encoding == "delta"
  if signed and width < 8 and value >= 1 << (8 * width - 1) then
    return value - (1 << (8 * width))
  end
  return value
end

function Section:value(row)
  local get = self:decoded(row // self.block)
  local place, width = row % self.block, get(1)
  if self.encoding ~= "delta" then return self:number(get, place, width) end
  local total = 0
  for index = 0, place do total = total + self:number(get, index, width) end
  return total
end

function Section:text(identifier)
  if identifier == 0 then return "" end
  local group, place = (identifier - 1) // self.group, (identifier - 1) % self.group
  local index, at = group // self.fanout, group % self.fanout
  local get = self:decoded(index)
  local left = self.count - index * self.block
  local total = math.min(self.fanout, ceil(left, self.group)) - 1
  local lengths, cursor = varints(get, 1, total)
  for step = 1, at do cursor = cursor + lengths[step] end
  local previous = {}
  for _ = 0, place do
    local shared = get(cursor)
    local fresh
    fresh, cursor = varint(get, cursor + 1)
    for spot = #previous, shared + 1, -1 do previous[spot] = nil end
    for offset = 0, fresh - 1 do previous[shared + 1 + offset] = get(cursor + offset) end
    cursor = cursor + fresh
  end
  return string.char(table.unpack(previous))
end

function Section:heads(index)
  local get = self:decoded(index)
  local count, cursor = varint(get, 1)
  local total = ceil(count, self.group)
  local heads = { self.keys[index + 1] }
  for step = 2, total do
    local gap
    gap, cursor = wide_varint(get, cursor)
    heads[step] = add(heads[step - 1], gap)
  end
  local sizes
  sizes, cursor = varints(get, cursor, total - 1)
  local starts = { cursor }
  for step = 1, total - 1 do starts[step + 1] = starts[step] + sizes[step] end
  return heads, starts
end

function Section:values(group)
  local index, at = group // self.fanout, group % self.fanout
  local heads, starts = self:heads(index)
  local get = self:decoded(index)
  local size = math.min(self.group, self.count - group * self.group)
  local wide = self.width == 16
  local network = wide and heads[at + 1][1] or heads[at + 1][2]
  local gaps, cursor = varints(get, starts[at + 1], size - 1)
  local values = {}
  for step = 1, size do
    if step > 1 then network = network + gaps[step - 1] end
    values[step] = { 0, network }
  end
  if not wide then return values end
  for step = 1, size do
    values[step][1] = values[step][2]
    values[step][2], cursor = varint(get, cursor)
  end
  return values
end

function Section:row(address)
  local index = upper(self.keys, address)
  if index == 0 then return nil end
  local heads = self:heads(index - 1)
  local group = (index - 1) * self.fanout + upper(heads, address) - 1
  local values = self:values(group)
  local spot = upper(values, address)
  if spot == 0 then return nil end
  local found = values[spot]
  return group * self.group + spot - 1, found[1] == address[1] and found[2] == address[2]
end

local function decode(text)
  local at = 1
  local value

  local function skip() at = text:find("[^ \t\r\n]", at) or #text + 1 end

  local function word()
    local close, piece = at + 1, {}
    while true do
      local stop = text:find('["\\]', close)
      piece[#piece + 1] = text:sub(close, stop - 1)
      if text:sub(stop, stop) == '"' then
        at = stop + 1
        return table.concat(piece)
      end
      local escape = text:sub(stop + 1, stop + 1)
      if escape == "u" then
        local point = tonumber(text:sub(stop + 2, stop + 5), 16)
        close = stop + 6
        if point >= 0xD800 and point < 0xDC00 then
          local low = tonumber(text:sub(stop + 8, stop + 11), 16)
          point, close = 0x10000 + ((point - 0xD800) << 10) + (low - 0xDC00), stop + 12
        end
        piece[#piece + 1] = utf8.char(point)
      else
        local plain = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }
        piece[#piece + 1] = plain[escape] or escape
        close = stop + 2
      end
    end
  end

  local function many(stop, each)
    at = at + 1
    skip()
    if text:sub(at, at) == stop then
      at = at + 1
      return
    end
    while true do
      each()
      skip()
      local next_character = text:sub(at, at)
      at = at + 1
      if next_character == stop then return end
    end
  end

  function value()
    skip()
    local first = text:sub(at, at)
    if first == "{" then
      local object = {}
      many("}", function()
        skip()
        local name = word()
        skip()
        at = at + 1
        object[name] = value()
      end)
      return object
    end
    if first == "[" then
      local list = {}
      many("]", function() list[#list + 1] = value() end)
      return list
    end
    if first == '"' then return word() end
    for literal, result in pairs({ ["true"] = true, ["false"] = false, null = null }) do
      if text:sub(at, at + #literal - 1) == literal then
        at = at + #literal
        return result
      end
    end
    local number = text:match("^-?[%d.eE+-]+", at)
    at = at + #number
    return math.tointeger(tonumber(number)) or tonumber(number)
  end

  return value()
end

local function quote(text)
  return '"' .. text:gsub('[%c"\\]', function(character)
    local named = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\t"] = "\\t" }
    return named[character] or string.format("\\u%04x", byte(character))
  end) .. '"'
end

local function figure(number)
  if math.type(number) == "integer" then return tostring(number) end
  local text
  for digits = 15, 17 do
    text = string.format("%." .. digits .. "g", number)
    if tonumber(text) == number then break end
  end
  return text:find("[.eEn]") and text or text .. ".0"
end

local function encode(value, indent)
  if value == null then return "null" end
  local kind = type(value)
  if kind == "string" then return quote(value) end
  if kind == "boolean" then return tostring(value) end
  if kind == "number" then return figure(value) end
  local names = {}
  for name in pairs(value) do names[#names + 1] = name end
  if #names == 0 then return "{}" end
  table.sort(names)
  local inner, lines = indent .. "  ", {}
  for index, name in ipairs(names) do
    lines[index] = inner .. quote(name) .. ": " .. encode(value[name], inner)
  end
  return "{\n" .. table.concat(lines, ",\n") .. "\n" .. indent .. "}"
end

local function parse_four(text)
  local parts = { text:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$") }
  if #parts ~= 4 then return nil end
  local value = 0
  for _, part in ipairs(parts) do
    local octet = tonumber(part)
    if octet > 255 or (#part > 1 and part:sub(1, 1) == "0") then return nil end
    value = (value << 8) | octet
  end
  return value
end

local function words(part)
  local found = {}
  if part == "" then return found end
  for piece in (part .. ":"):gmatch("([^:]*):") do
    if piece:find("%.") then
      local four = parse_four(piece)
      if not four then return nil end
      found[#found + 1] = four >> 16
      found[#found + 1] = four & 0xFFFF
    elseif piece:match("^%x%x?%x?%x?$") then
      found[#found + 1] = tonumber(piece, 16)
    else
      return nil
    end
  end
  return found
end

local function parse_six(text)
  local head, tail = text:match("^(.-)::(.*)$")
  local left, right = words(head or text), words(tail or "")
  if not left or not right or (tail and tail:find("::")) then return nil end
  local missing = 8 - #left - #right
  if (head and missing < 1) or (not head and missing ~= 0) then return nil end
  local all = left
  for _ = 1, missing do all[#all + 1] = 0 end
  for _, word in ipairs(right) do all[#all + 1] = word end
  local high, low = 0, 0
  for index = 1, 4 do
    high = (high << 16) | all[index]
    low = (low << 16) | all[index + 4]
  end
  return { high, low }
end

local Plevin = {}
Plevin.__index = Plevin

local function open(path)
  local handle = io.open(path, "rb")
  local file = handle and handle:read("a")
  if not file or file:sub(1, 8) ~= "PLEVIN\0\2" then
    fail(path .. " is not a plevin 2 database")
  end
  local size = unpack("<I4", file, 9)
  local head = decode(file:sub(13, 12 + size))
  local self = setmetatable({ sections = {}, books = {}, tables = {} }, Plevin)
  for name, entry in pairs(head.sections) do
    local at = 12 + size + entry.offset
    self.sections[name] = section(file:sub(at + 1, at + entry.bytes), entry)
    local kind, owner, field = name:match("^(%a+)%.([^.]+)%.([^.]+)$")
    if kind == "col" or kind == "link" then
      self.tables[owner] = self.tables[owner] or {}
      local column = { field = field, link = kind == "link", name = name }
      table.insert(self.tables[owner], column)
    end
  end
  for field, book in pairs(BOOKS) do self.books[field] = head.vocabularies[book] end
  return self
end

function Plevin:read(name, column, value)
  if name == "abuse.risk" then return value == 255 and null or value / 100 end
  if name == "abuse.is_anycast" or name == "abuse.is_satellite" then return value ~= 0 end
  local book = self.books[name]
  if book then return book[value + 1] or "" end
  if column.read == "text" then return self.sections.strings:text(value) end
  if column.read ~= "" then return value / 10000 end
  return value
end

function Plevin:row(owner, row)
  local out = {}
  for _, column in ipairs(self.tables[owner] or {}) do
    local section = self.sections[column.name]
    local value = section:value(row)
    if not column.link then
      out[column.field] = self:read(owner .. "." .. column.field, section, value)
    elseif value ~= 0 then
      out[column.field] = self:row(column.field, value - 1)
    end
  end
  if out.postal_partial then
    local stop = utf8.offset(out.postal, out.postal_partial + 1)
    out.postal_partial = out.postal:sub(1, stop and stop - 1 or #out.postal)
  end
  return out
end

function Plevin:answer(version, row, override)
  local out = {}
  for _, name in ipairs(CARRIED) do
    local column = self.sections["spine." .. version .. "." .. name]
    local overridden = override ~= 0 and name == "abuse"
    local value = column and (overridden and override or column:value(row))
    if column and not LINKED[name] then
      out.network = out.network or {}
      out.network[name] = self:read(name, column, value)
    elseif column and value ~= 0 then
      out[name] = self:row(name, value - 1)
    end
  end
  return out
end

function Plevin:lookup(text)
  local version = text:find(":", 1, true) and "v6" or "v4"
  local address = version == "v6" and parse_six(text) or { 0, parse_four(text) }
  if not address[2] then fail(text .. " is not an address") end
  local spine = self.sections["spine." .. version]
  local row = spine and spine:row(address)
  if not row then return null end
  local hosts = self.sections["hosts." .. version]
  local records = self.sections["hosts." .. version .. ".abuse"]
  local override = 0
  if hosts and records then
    local at, exact = hosts:row(address)
    if exact then override = records:value(at) + 1 end
  end
  return self:answer(version, row, override)
end

if #arg ~= 2 then fail("usage: lua plevin.lua path address") end
print(encode(open(arg[1]):lookup(arg[2]), ""))

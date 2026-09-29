package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/bits"
	"net/netip"
	"os"
	"sort"
	"strings"
)

const (
	isRepeat = 192
	isFirst  = isRepeat + 12
	isSecond = isFirst + 12
	isThird  = isSecond + 12
	isLong   = isThird + 12
	slots    = isLong + 192
	special  = slots + 256
	align    = special + 114
	lengths  = align + 16
	repeats  = lengths + 514
	literals = repeats + 514
)

var carried = []string{"place", "network", "abuse", "prefix", "rpki", "roas"}

var books = map[string]string{
	"rpki": "rpki", "place.granularity": "granularity", "city.timezone": "timezones",
	"city.type": "place_types", "operator.category": "categories",
	"abuse.user_type": "categories", "abuse.service": "services",
	"abuse.evidence": "evidence",
}

type U128 struct{ High, Low uint64 }

func (a U128) Less(b U128) bool {
	return a.High < b.High || a.High == b.High && a.Low < b.Low
}

func (a U128) Add(b U128) U128 {
	low, carry := bits.Add64(a.Low, b.Low, 0)
	return U128{a.High + b.High + carry, low}
}

type Lzma struct {
	data  []byte
	at    int
	rng   uint32
	code  uint32
	probs []uint16
	out   []byte
}

func (d *Lzma) normalize() {
	if d.rng < 1<<24 {
		d.rng <<= 8
		d.code = d.code<<8 | uint32(d.data[d.at])
		d.at++
	}
}

func (d *Lzma) bit(index int) int {
	chance := uint32(d.probs[index])
	bound := (d.rng >> 11) * chance
	bit := 0
	if d.code < bound {
		d.rng = bound
		d.probs[index] += uint16((2048 - chance) >> 5)
	} else {
		d.rng -= bound
		d.code -= bound
		d.probs[index] -= uint16(chance >> 5)
		bit = 1
	}
	d.normalize()
	return bit
}

func (d *Lzma) direct(count int) uint32 {
	value := uint32(0)
	for range count {
		d.rng >>= 1
		bit := uint32(0)
		if d.code >= d.rng {
			d.code -= d.rng
			bit = 1
		}
		value = value<<1 | bit
		d.normalize()
	}
	return value
}

func (d *Lzma) tree(base, count int) int {
	symbol := 1
	for range count {
		symbol = symbol<<1 | d.bit(base+symbol)
	}
	return symbol - 1<<count
}

func (d *Lzma) reversed(base, count int) int {
	symbol, value := 1, 0
	for step := range count {
		bit := d.bit(base + symbol)
		symbol = symbol<<1 | bit
		value |= bit << step
	}
	return value
}

func (d *Lzma) length(base, spot int) int {
	if d.bit(base) == 0 {
		return d.tree(base+2+spot<<3, 3)
	}
	if d.bit(base+1) == 0 {
		return 8 + d.tree(base+130+spot<<3, 3)
	}
	return 16 + d.tree(base+258, 8)
}

func (d *Lzma) distance(length int) uint32 {
	slot := d.tree(slots+min(length, 3)<<6, 6)
	if slot < 4 {
		return uint32(slot)
	}
	count := slot>>1 - 1
	base := uint32(2|slot&1) << count
	if slot < 14 {
		return base + uint32(d.reversed(special+int(base)-slot-1, count))
	}
	return base + d.direct(count-4)<<4 + uint32(d.reversed(align, 4))
}

func (d *Lzma) literal(state int, recent uint32, context, position int) {
	size := len(d.out)
	previous := 0
	if size > 0 {
		previous = int(d.out[size-1])
	}
	base := literals + 0x300*((size&(1<<position-1))<<context+previous>>(8-context))
	symbol := 1
	if state >= 7 {
		matched := int(d.out[size-int(recent)-1])
		for symbol < 0x100 {
			bit := matched >> 7 & 1
			matched <<= 1
			read := d.bit(base + (1+bit)<<8 + symbol)
			symbol = symbol<<1 | read
			if read != bit {
				break
			}
		}
	}
	for symbol < 0x100 {
		symbol = symbol<<1 | d.bit(base+symbol)
	}
	d.out = append(d.out, byte(symbol))
}

func (d *Lzma) rotate(state int, recent *[4]uint32) {
	held := recent[1]
	if d.bit(isSecond+state) == 1 {
		held = recent[2]
		if d.bit(isThird+state) == 1 {
			held = recent[3]
			recent[3] = recent[2]
		}
		recent[2] = recent[1]
	}
	recent[1] = recent[0]
	recent[0] = held
}

func pick(state, literal, match int) int {
	if state < 7 {
		return literal
	}
	return match
}

func afterLiteral(state int) int {
	if state < 4 {
		return 0
	}
	if state < 10 {
		return state - 3
	}
	return state - 6
}

func decompress(data []byte, tuning [3]int) []byte {
	context, position, matches := tuning[0], tuning[1], tuning[2]
	d := &Lzma{data: data, at: 5, rng: 0xFFFFFFFF, code: binary.BigEndian.Uint32(data[1:])}
	d.probs = make([]uint16, literals+0x300<<(context+position))
	for index := range d.probs {
		d.probs[index] = 1024
	}
	state := 0
	var recent [4]uint32
	for {
		spot := len(d.out) & (1<<matches - 1)
		if d.bit(state<<4|spot) == 0 {
			d.literal(state, recent[0], context, position)
			state = afterLiteral(state)
			continue
		}
		length := 0
		if d.bit(isRepeat+state) == 1 {
			if d.bit(isFirst+state) == 1 {
				d.rotate(state, &recent)
			} else if d.bit(isLong+(state<<4|spot)) == 0 {
				state = pick(state, 9, 11)
				d.out = append(d.out, d.out[len(d.out)-int(recent[0])-1])
				continue
			}
			length = d.length(repeats, spot)
			state = pick(state, 8, 11)
		} else {
			recent = [4]uint32{0, recent[0], recent[1], recent[2]}
			length = d.length(lengths, spot)
			state = pick(state, 7, 10)
			recent[0] = d.distance(length)
			if recent[0] == 0xFFFFFFFF {
				return d.out
			}
		}
		from := len(d.out) - int(recent[0]) - 1
		for step := range length + 2 {
			d.out = append(d.out, d.out[from+step])
		}
	}
}

func varint(data []byte, at int) (uint64, int) {
	value, shift := uint64(0), 0
	for data[at]&0x80 != 0 {
		value |= uint64(data[at]&0x7F) << shift
		at, shift = at+1, shift+7
	}
	return value | uint64(data[at])<<shift, at + 1
}

func varint128(data []byte, at int) (U128, int) {
	var value U128
	for shift := 0; ; shift += 7 {
		chunk := uint64(data[at] & 0x7F)
		if shift < 64 {
			value.Low |= chunk << shift
			value.High |= chunk >> (64 - shift)
		} else {
			value.High |= chunk << (shift - 64)
		}
		at++
		if data[at-1]&0x80 == 0 {
			return value, at
		}
	}
}

func key(raw []byte) U128 {
	var value U128
	for _, octet := range raw {
		value = U128{value.High<<8 | value.Low>>56, value.Low<<8 | uint64(octet)}
	}
	return value
}

func ceil(value, divisor int) int { return (value + divisor - 1) / divisor }

type Entry struct {
	Offset, Bytes, Count, Block, Group int
	Encoding, Read                     string
	Lzma                               [3]int
}

type Section struct {
	Entry
	width   int
	offsets []int
	keys    []U128
	data    []byte
	blocks  map[int][]byte
}

func newSection(view []byte, entry Entry) *Section {
	count := int(binary.LittleEndian.Uint32(view))
	width := int(binary.LittleEndian.Uint32(view[4:]))
	section := &Section{Entry: entry, width: width, blocks: map[int][]byte{}}
	for index := range count + 1 {
		offset := binary.LittleEndian.Uint32(view[8+4*index:])
		section.offsets = append(section.offsets, int(offset))
	}
	at := 8 + 4*(count+1)
	for range count {
		section.keys = append(section.keys, key(view[at:at+width]))
		at += width
	}
	section.data = view[at:]
	return section
}

func (s *Section) fanout() int { return s.Block / s.Group }

func (s *Section) block(index int) []byte {
	if s.blocks[index] == nil {
		packed := s.data[s.offsets[index]:s.offsets[index+1]]
		s.blocks[index] = decompress(packed, s.Lzma)
	}
	return s.blocks[index]
}

func (s *Section) number(block []byte, place, width int) int64 {
	raw := block[1+place*width : 1+(place+1)*width]
	value := uint64(0)
	for index := width - 1; index >= 0; index-- {
		value = value<<8 | uint64(raw[index])
	}
	if s.Encoding == "fixed" {
		return int64(value)
	}
	shift := 64 - 8*width
	return int64(value<<shift) >> shift
}

func (s *Section) value(row int) int64 {
	block := s.block(row / s.Block)
	place, width := row%s.Block, int(block[0])
	if s.Encoding != "delta" {
		return s.number(block, place, width)
	}
	total := int64(0)
	for index := range place + 1 {
		total += s.number(block, index, width)
	}
	return total
}

func (s *Section) text(identifier int64) string {
	if identifier == 0 {
		return ""
	}
	group, place := int(identifier-1)/s.Group, int(identifier-1)%s.Group
	index, at := group/s.fanout(), group%s.fanout()
	block := s.block(index)
	total := min(s.fanout(), ceil(s.Count-index*s.Block, s.Group)) - 1
	cursor, start := 0, 0
	for step := range total {
		var length uint64
		length, cursor = varint(block, cursor)
		if step < at {
			start += int(length)
		}
	}
	cursor += start
	var previous []byte
	for range place + 1 {
		shared := int(block[cursor])
		fresh, next := varint(block, cursor+1)
		previous = append(previous[:shared:shared], block[next:next+int(fresh)]...)
		cursor = next + int(fresh)
	}
	return string(previous)
}

func (s *Section) heads(index int) ([]U128, []int) {
	block := s.block(index)
	count, cursor := varint(block, 0)
	total := ceil(int(count), s.Group)
	heads := []U128{s.keys[index]}
	for range total - 1 {
		var gap U128
		gap, cursor = varint128(block, cursor)
		heads = append(heads, heads[len(heads)-1].Add(gap))
	}
	sizes := make([]uint64, total-1)
	for step := range sizes {
		sizes[step], cursor = varint(block, cursor)
	}
	starts := []int{cursor}
	for _, size := range sizes {
		starts = append(starts, starts[len(starts)-1]+int(size))
	}
	return heads, starts
}

func (s *Section) values(group int) []U128 {
	index, at := group/s.fanout(), group%s.fanout()
	heads, starts := s.heads(index)
	block := s.block(index)
	size := min(s.Group, s.Count-group*s.Group)
	network, cursor := heads[at].Low, starts[at]
	if s.width == 16 {
		network = heads[at].High
	}
	networks := []uint64{network}
	for range size - 1 {
		var gap uint64
		gap, cursor = varint(block, cursor)
		network += gap
		networks = append(networks, network)
	}
	values := make([]U128, size)
	for step, network := range networks {
		values[step] = U128{0, network}
		if s.width == 16 {
			values[step].High = network
			values[step].Low, cursor = varint(block, cursor)
		}
	}
	return values
}

func upper(values []U128, address U128) int {
	return sort.Search(len(values), func(index int) bool { return address.Less(values[index]) })
}

func (s *Section) row(address U128) (int, bool) {
	index := upper(s.keys, address) - 1
	if index < 0 {
		return -1, false
	}
	heads, _ := s.heads(index)
	group := index*s.fanout() + upper(heads, address) - 1
	values := s.values(group)
	spot := upper(values, address) - 1
	if spot < 0 {
		return -1, false
	}
	return group*s.Group + spot, values[spot] == address
}

type Column struct {
	field   string
	link    bool
	section *Section
}

type Plevin struct {
	sections map[string]*Section
	books    map[string][]string
	tables   map[string][]Column
}

func open(path string) *Plevin {
	data, err := os.ReadFile(path)
	if err != nil || !bytes.HasPrefix(data, []byte("PLEVIN\x00\x02")) {
		fail(path + " is not a plevin 2 database")
	}
	size := int(binary.LittleEndian.Uint32(data[8:]))
	var head struct {
		Sections     map[string]Entry
		Vocabularies map[string][]string
	}
	if json.Unmarshal(data[12:12+size], &head) != nil {
		fail(path + " has a broken header")
	}
	plevin := &Plevin{map[string]*Section{}, map[string][]string{}, map[string][]Column{}}
	for name, entry := range head.Sections {
		at := 12 + size + entry.Offset
		plevin.sections[name] = newSection(data[at:at+entry.Bytes], entry)
		parts := strings.Split(name, ".")
		if len(parts) == 3 && (parts[0] == "col" || parts[0] == "link") {
			column := Column{parts[2], parts[0] == "link", plevin.sections[name]}
			plevin.tables[parts[1]] = append(plevin.tables[parts[1]], column)
		}
	}
	for field, book := range books {
		if words, ok := head.Vocabularies[book]; ok {
			plevin.books[field] = words
		}
	}
	return plevin
}

func (p *Plevin) read(name string, entry Entry, value int64) any {
	book, worded := p.books[name]
	switch {
	case name == "abuse.risk" && value == 255:
		return nil
	case name == "abuse.risk":
		return float64(value) / 100
	case name == "abuse.is_anycast" || name == "abuse.is_satellite":
		return value != 0
	case worded && value < int64(len(book)):
		return book[value]
	case worded:
		return ""
	case entry.Read == "text":
		return p.sections["strings"].text(value)
	case entry.Read != "":
		return float64(value) / 10000
	}
	return value
}

func (p *Plevin) row(table string, row int) map[string]any {
	out := map[string]any{}
	for _, column := range p.tables[table] {
		value := column.section.value(row)
		if !column.link {
			out[column.field] = p.read(table+"."+column.field, column.section.Entry, value)
		} else if value != 0 {
			out[column.field] = p.row(column.field, int(value-1))
		}
	}
	if partial, ok := out["postal_partial"].(int64); ok {
		postal := out["postal"].(string)
		out["postal_partial"] = postal[:min(int(partial), len(postal))]
	}
	return out
}

func (p *Plevin) lookup(text string) map[string]any {
	address, err := netip.ParseAddr(text)
	if err != nil {
		fail(text + " is not an address")
	}
	version, raw := "v6", address.As16()
	found := key(raw[:])
	if address.Is4() {
		version, found = "v4", key(raw[12:])
	}
	spine := p.sections["spine."+version]
	if spine == nil {
		return nil
	}
	row, _ := spine.row(found)
	if row < 0 {
		return nil
	}
	override := int64(0)
	hosts, records := p.sections["hosts."+version], p.sections["hosts."+version+".abuse"]
	if hosts != nil && records != nil {
		if at, exact := hosts.row(found); exact {
			override = records.value(at) + 1
		}
	}
	return p.answer(version, row, override)
}

func (p *Plevin) answer(version string, row int, override int64) map[string]any {
	out := map[string]any{}
	for _, name := range carried {
		column := p.sections["spine."+version+"."+name]
		if column == nil {
			continue
		}
		value := column.value(row)
		if override != 0 && name == "abuse" {
			value = override
		}
		switch {
		case name == "place" || name == "network" || name == "abuse":
			if value != 0 {
				out[name] = p.row(name, int(value-1))
			}
		default:
			if out["network"] == nil {
				out["network"] = map[string]any{}
			}
			out["network"].(map[string]any)[name] = p.read(name, column.Entry, value)
		}
	}
	return out
}

func fail(reason string) {
	fmt.Fprintln(os.Stderr, reason)
	os.Exit(1)
}

func main() {
	if len(os.Args) != 3 {
		fail("usage: plevin path address")
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	encoder.Encode(open(os.Args[1]).lookup(os.Args[2]))
}

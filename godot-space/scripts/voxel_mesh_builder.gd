extends RefCounted

const Torus = preload("res://scripts/torus.gd")
const ROOT := "res://world-data/"
const CHANNEL := VoxelBuffer.CHANNEL_COLOR
var records: Dictionary = {}
var buffers: Dictionary = {}
var handles: Dictionary = {}
var mesher := VoxelMesherCubes.new()

func _init(indices: Array = []) -> void:
	for sector in indices:
		for record in sector.records:
			records[record.id] = record
		if sector.has("far"):
			records[sector.far.id] = sector.far

func read_buffer(record: Dictionary) -> VoxelBuffer:
	if buffers.has(record.id):
		return buffers[record.id]
	if not handles.has(record.archive):
		handles[record.archive] = FileAccess.open(ROOT + record.archive, FileAccess.READ)
	var file: FileAccess = handles[record.archive]
	assert(file != null, "Missing voxel archive: " + record.archive)
	file.seek(int(record.offset))
	var bytes := file.get_buffer(int(record.length)).decompress(int(record.rawBytes), FileAccess.COMPRESSION_GZIP)
	assert(bytes.size() == int(record.rawBytes), "Invalid voxel archive record")
	var buffer := VoxelBuffer.new()
	buffer.set_channel_depth(CHANNEL, VoxelBuffer.DEPTH_32_BIT)
	buffer.create(int(record.size[0]), int(record.size[1]), int(record.size[2]))
	buffer.set_channel_from_byte_array(CHANNEL, bytes)
	# Keep a bounded per-job decoded cache, including sparse micro chunks.
	if buffers.size() >= 48:
		buffers.erase(buffers.keys()[0])
	buffers[record.id] = buffer
	return buffer

func padded_buffer(record: Dictionary) -> VoxelBuffer:
	var n := Vector3i(int(record.size[0]), int(record.size[1]), int(record.size[2]))
	var result := VoxelBuffer.new()
	result.set_channel_depth(CHANNEL, VoxelBuffer.DEPTH_32_BIT)
	result.create(n.x + 2, n.y + 2, n.z + 2)
	var origin := Vector3(record.origin[0], record.origin[1], record.origin[2])
	var span := Vector3(n) * float(record.scale)
	for dz in range(-1, 2):
		for dx in range(-1, 2):
			for dy in range(-1, 2):
				var neighbour := origin + Vector3(dx, dy, dz) * span
				neighbour.x = fposmod(neighbour.x, Torus.SIZE_X)
				neighbour.z = fposmod(neighbour.z, Torus.SIZE_Z)
				var id := "%s:%d:%d:%d" % [record.kind, int(neighbour.x), int(neighbour.y), int(neighbour.z)]
				if not records.has(id):
					continue
				var start := Vector3i.ZERO
				var end := n
				var destination := Vector3i.ONE
				var shifts := [dx, dy, dz]
				for axis in 3:
					if shifts[axis] < 0:
						start[axis] = n[axis] - 1
						destination[axis] = 0
					elif shifts[axis] > 0:
						end[axis] = 1
						destination[axis] = n[axis] + 1
				result.copy_channel_from_area(read_buffer(records[id]), start, end, destination, CHANNEL)
	return result

func prepare(selected: Array, kind: String) -> Array:
	var prepared := []
	for record in selected:
		if record.kind == kind:
			prepared.append({"record": record, "buffer": padded_buffer(record)})
	return prepared

# Called on the main thread only: VoxelMesherCubes.build_mesh creates rendering RIDs.
static func extract(prepared: Dictionary, cubes: VoxelMesherCubes) -> Array:
	var surfaces := []
	var mesh := cubes.build_mesh(prepared.buffer, [])
	if mesh != null:
		for surface in mesh.get_surface_count():
			surfaces.append({"record": prepared.record, "arrays": mesh.surface_get_arrays(surface)})
	return surfaces

# Pure CPU work. Detached packed arrays can safely be transformed by a worker.
static func project(surfaces: Array) -> Array:
	var vertices := PackedVector3Array()
	var colors := PackedColorArray()
	var indices := PackedInt32Array()
	var light := Vector3(-0.45, 0.85, 0.3).normalized()
	for surface in surfaces:
		var record: Dictionary = surface.record
		var origin := Vector3(record.origin[0], record.origin[1], record.origin[2])
		var arrays: Array = surface.arrays
		var v: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
		var c: PackedColorArray = arrays[Mesh.ARRAY_COLOR]
		var normal: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]
		var index: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
		var offset := vertices.size()
		for i in v.size():
			v[i] = Torus.bend(origin + v[i] * float(record.scale))
			var emissive := c[i].a < 0.999
			var color := Color(c[i].r, c[i].g, c[i].b, 1.0).srgb_to_linear()
			var shade := 1.0 if emissive else 0.45 + 0.55 * maxf(0.0, normal[i].dot(light))
			c[i] = Color(color.r * shade, color.g * shade, color.b * shade, 1.0)
		for i in index.size():
			index[i] += offset
		vertices.append_array(v)
		colors.append_array(c)
		indices.append_array(index)
	var result := []
	result.resize(Mesh.ARRAY_MAX)
	result[Mesh.ARRAY_VERTEX] = vertices
	result[Mesh.ARRAY_COLOR] = colors
	result[Mesh.ARRAY_INDEX] = indices
	return result

func build(selected: Array, kind: String) -> Array:
	# Synchronous offline baker. Runtime uses the same phases with a frame budget.
	mesher.greedy_meshing_enabled = kind != "far"
	var surfaces := []
	for item in prepare(selected, kind):
		surfaces.append_array(extract(item, mesher))
	return project(surfaces)

static func material() -> StandardMaterial3D:
	var result := StandardMaterial3D.new()
	result.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	result.vertex_color_use_as_albedo = true
	result.vertex_color_is_srgb = false
	result.cull_mode = BaseMaterial3D.CULL_BACK
	return result

static func mesh_from_arrays(arrays: Array, shared_material: Material) -> ArrayMesh:
	var mesh := ArrayMesh.new()
	if arrays[Mesh.ARRAY_VERTEX].is_empty():
		return mesh
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh.surface_set_material(0, shared_material)
	return mesh

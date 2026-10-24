extends SceneTree

func _initialize() -> void:
	call_deferred("bake")

func bake() -> void:
	var started := Time.get_ticks_msec()
	if not ClassDB.class_exists("VoxelMesherCubes"):
		push_error("This project requires the Godot + Voxel Tools build.")
		quit(1)
		return
	var manifest = JSON.parse_string(FileAccess.get_file_as_string("res://data/manifest.json"))
	if not manifest is Dictionary:
		push_error("Run node godot-space/tools/export-map.ts first.")
		quit(1)
		return
	DirAccess.make_dir_recursive_absolute("res://baked")
	var mesher := VoxelMesherCubes.new()
	mesher.greedy_meshing_enabled = true
	assert(mesher.get_minimum_padding() == 1 and mesher.get_maximum_padding() == 1)
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.vertex_color_use_as_albedo = true
	material.vertex_color_is_srgb = false
	material.cull_mode = BaseMaterial3D.CULL_BACK
	var root := Node3D.new()
	root.name = "AetherArchipelago"
	var archive := FileAccess.open("res://baked/surfaces.bin", FileAccess.WRITE)
	var surfaces: Array = []
	var mesh_count := 0
	var triangle_count := 0
	var light := Vector3(-0.45, 0.85, 0.3).normalized()
	for record in manifest.records:
		var packed := FileAccess.get_file_as_bytes("res://data/" + record.file)
		var bytes := packed.decompress(int(record.rawBytes), FileAccess.COMPRESSION_GZIP)
		assert(bytes.size() == int(record.rawBytes))
		var buffer := VoxelBuffer.new()
		buffer.set_channel_depth(VoxelBuffer.CHANNEL_COLOR, VoxelBuffer.DEPTH_32_BIT)
		var n := int(record.padded)
		buffer.create(n, n, n)
		buffer.set_channel_from_byte_array(VoxelBuffer.CHANNEL_COLOR, bytes)
		var mesh := mesher.build_mesh(buffer, [])
		if mesh == null:
			continue
		var result := ArrayMesh.new()
		var pos := Vector3(record.origin[0], record.origin[1], record.origin[2])
		var scale_value := float(record.scale)
		for s in mesh.get_surface_count():
			var arrays := mesh.surface_get_arrays(s)
			var vertices: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
			var normals: PackedVector3Array = arrays[Mesh.ARRAY_NORMAL]
			var colors: PackedColorArray = arrays[Mesh.ARRAY_COLOR]
			var indices: PackedInt32Array = arrays[Mesh.ARRAY_INDEX]
			for i in vertices.size():
				vertices[i] = vertices[i] * scale_value + pos
				var color := colors[i]
				var emission := color.a < 0.999
				color.a = 1.0
				color = color.srgb_to_linear()
				var shade := 1.0 if emission else 0.45 + 0.55 * maxf(0.0, normals[i].dot(light))
				colors[i] = Color(color.r * shade, color.g * shade, color.b * shade, 1.0)
			arrays[Mesh.ARRAY_VERTEX] = vertices
			arrays[Mesh.ARRAY_COLOR] = colors
			result.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
			result.surface_set_material(result.get_surface_count() - 1, material)
			var offset := archive.get_position()
			archive.store_buffer(vertices.to_byte_array())
			archive.store_buffer(colors.to_byte_array())
			archive.store_buffer(indices.to_byte_array())
			surfaces.append({"offset": offset, "vertices": vertices.size(), "indices": indices.size(), "chunk": record.file})
			triangle_count += indices.size() / 3
		var instance := MeshInstance3D.new()
		instance.name = "Chunk_%d" % mesh_count
		instance.mesh = result
		instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		root.add_child(instance)
		instance.owner = root
		mesh_count += 1
		if mesh_count % 200 == 0:
			print("Baked ", mesh_count, "/", manifest.records.size())
	archive.close()
	var scene := PackedScene.new()
	assert(scene.pack(root) == OK)
	assert(ResourceSaver.save(scene, "res://baked/aether.scn") == OK)
	var summary := {"world": manifest.world, "seed": manifest.seed, "sourceSha256": manifest.sourceSha256,
		"bounds": manifest.bounds, "voxelCounts": manifest.counts, "meshes": mesh_count,
		"triangles": triangle_count, "surfaces": surfaces, "godot": Engine.get_version_info().string,
		"lighting": "Identical precomputed vertex lighting; opaque emission, no shadows, AA, fog, LOD or post effects.",
		"seconds": (Time.get_ticks_msec() - started) / 1000.0}
	var file := FileAccess.open("res://baked/manifest.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(summary))
	file.close()
	root.free()
	print("BAKE_COMPLETE ", mesh_count, " meshes, ", triangle_count, " triangles, ", summary.seconds, " s")
	quit()

extends SceneTree

const Builder = preload("res://scripts/voxel_mesh_builder.gd")

func _initialize() -> void:
	call_deferred("bake")

func bake() -> void:
	var manifest: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://world-data/manifest.json"))
	var sectors: Dictionary = {}
	for zone in manifest.zones:
		var sector: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://world-data/" + zone.index))
		# Coarse bake needs only far records, not every micro chunk's metadata.
		sector.records = []
		sectors["%d_%d" % [zone.x, zone.z]] = sector
	var root := Node3D.new()
	root.name = "TorusFarWorld"
	var material := Builder.material()
	var triangles := 0
	var started := Time.get_ticks_msec()
	for zone in manifest.zones:
		var neighbours := []
		for dz in range(-1, 2):
			for dx in range(-1, 2):
				neighbours.append(sectors["%d_%d" % [posmod(int(zone.x) + dx, 128), posmod(int(zone.z) + dz, 16)]])
		var sector: Dictionary = sectors["%d_%d" % [zone.x, zone.z]]
		var builder := Builder.new(neighbours)
		var arrays := builder.build([sector.far], "far")
		triangles += arrays[Mesh.ARRAY_INDEX].size() / 3
		var mesh := Builder.mesh_from_arrays(arrays, material)
		var instance := MeshInstance3D.new()
		instance.name = "Far_%d_%d" % [zone.x, zone.z]
		instance.mesh = mesh
		instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		root.add_child(instance)
		instance.owner = root
		if root.get_child_count() % 128 == 0:
			print("FAR_BAKE ", root.get_child_count(), "/2048")
	DirAccess.make_dir_recursive_absolute("res://baked")
	var scene := PackedScene.new()
	assert(scene.pack(root) == OK)
	assert(ResourceSaver.save(scene, "res://baked/torus-far.scn", ResourceSaver.FLAG_COMPRESS) == OK)
	var summary := {"world": manifest.world, "seed": manifest.seed, "sourceSha256": manifest.sourceSha256,
		"projection": "closed conformal torus", "size": manifest.size, "sectors": manifest.zones.size(),
		"farTriangles": triangles, "voxelCounts": manifest.counts, "farVoxelSize": 8,
		"seconds": (Time.get_ticks_msec() - started) / 1000.0}
	var file := FileAccess.open("res://baked/torus-manifest.json", FileAccess.WRITE)
	file.store_string(JSON.stringify(summary, "\t"))
	root.free()
	print("TORUS_BAKE_COMPLETE ", JSON.stringify(summary))
	quit()

extends SceneTree

const Torus = preload("res://scripts/torus.gd")
const Builder = preload("res://scripts/voxel_mesh_builder.gd")
const Stream = preload("res://scripts/world_stream.gd")

func _initialize() -> void:
	call_deferred("run_tests")

func vector(value: Array) -> Vector3:
	return Vector3(value[0], value[1], value[2])

func wait_for_stream(stream: Node3D) -> void:
	var deadline := Time.get_ticks_msec() + 90000
	await create_timer(0.6).timeout
	while true:
		var stats: Dictionary = stream.statistics()
		if stats.pendingJobs == 0 and stats.queuedJobs == 0:
			break
		assert(Time.get_ticks_msec() < deadline, "Streaming did not settle")
		await create_timer(0.2).timeout
	assert(stream.statistics().solidSectors > 0)
	assert(stream.statistics().microSectors > 0)
	for loaded in stream.loaded.values():
		assert(loaded.node.mesh != null, "A streamed mesh failed to build")
		assert(loaded.node.mesh.get_surface_count() > 0, "A populated sector has no mesh")
		if loaded.kind == "solid":
			assert(not stream.far["%d_%d" % [loaded.x, loaded.z]].visible)

func run_tests() -> void:
	var fixtures: Array = JSON.parse_string(FileAccess.get_file_as_string("res://results/torus-reference.json"))
	for fixture in fixtures:
		var point := vector(fixture.point)
		assert(Torus.bend(point).distance_to(vector(fixture.bent)) < 0.003, "Projection differs from Space")
		var basis := Torus.frame(point)
		assert(absf(basis.determinant() - 1.0) < 0.00001)
		for axis in 3:
			assert(basis[axis].distance_to(vector(fixture.axes[axis])) < 0.00001)
	for point in [Vector3(16383.5, 180, 1024), Vector3(8192,180,2047.5)]:
		var step := Vector3(1,0,0) if point.x > 16000 else Vector3(0,0,1)
		assert(Torus.bend(point).distance_to(Torus.bend(Torus.wrapped(point + step))) < 2.0)
	assert(Torus.sector_distance(127,15,Vector3(1,180,1)) < 100)
	var neighbours := []
	for dz in range(-1,2):
		for dx in range(-1,2):
			neighbours.append(JSON.parse_string(FileAccess.get_file_as_string("res://world-data/sectors/%d_%d.json" % [posmod(dx,128),posmod(dz,16)])))
	var builder := Builder.new(neighbours)
	var padded := builder.padded_buffer(builder.records["far:0:0:0"])
	var left := builder.read_buffer(builder.records["far:16256:0:0"])
	var back := builder.read_buffer(builder.records["far:0:0:1920"])
	for y in 32:
		for i in 16:
			assert(padded.get_voxel(0,y+1,i+1,VoxelBuffer.CHANNEL_COLOR) == left.get_voxel(15,y,i,VoxelBuffer.CHANNEL_COLOR))
			assert(padded.get_voxel(i+1,y+1,0,VoxelBuffer.CHANNEL_COLOR) == back.get_voxel(i,y,15,VoxelBuffer.CHANNEL_COLOR))
	print("TORUS_MATH_AND_PERIODIC_HALOS_PASS")
	var stream := Stream.new()
	root.add_child(stream)
	stream.set_view(Vector3(8192.5,180,1024.5),false)
	await wait_for_stream(stream)
	print("SPAWN_STREAM_PASS ", JSON.stringify(stream.statistics()))
	stream.set_view(Vector3(16380,180,2044),false)
	await wait_for_stream(stream)
	for key in ["solid:127_15","solid:0_15","solid:127_0","solid:0_0"]:
		assert(stream.loaded.has(key), "Missing seam neighbour " + key)
	stream.set_view(Vector3(4,180,4),false)
	await wait_for_stream(stream)
	print("BOTH_SEAMS_STREAM_PASS ", JSON.stringify(stream.statistics()))
	stream.set_view(Vector3(4,180,4),true)
	await create_timer(1.0).timeout
	assert(stream.loaded.is_empty())
	for mesh in stream.far.values(): assert(mesh.visible)
	stream.queue_free()
	await process_frame
	print("TORUS_STREAM_UNLOAD_PASS")
	var tour: Node3D = load("res://main.tscn").instantiate()
	root.add_child(tour)
	assert(tour.overview)
	send_key(KEY_F2, true)
	send_key(KEY_F2, false)
	await process_frame
	assert(not tour.overview, "F2 did not enter the islands")
	tour.logical_position = Vector3(16383.5, 180, 2047.5)
	tour.yaw = -PI / 2
	tour.pitch = 0.0
	tour.update_camera()
	var before: Vector3 = tour.camera.position
	send_key(KEY_W, true)
	await create_timer(0.15).timeout
	send_key(KEY_W, false)
	assert(tour.logical_position.x < 32, "Flight did not cross the X seam")
	assert(tour.camera.position.distance_to(before) < 15, "Camera jumped at the seam")
	tour.yaw = PI
	send_key(KEY_W, true)
	await create_timer(0.15).timeout
	send_key(KEY_W, false)
	assert(tour.logical_position.z < 32, "Flight did not cross the Z seam")
	send_key(KEY_F2, true)
	send_key(KEY_F2, false)
	await process_frame
	assert(tour.overview, "F2 did not return to the whole-ring view")
	tour.queue_free()
	await process_frame
	print("TOUR_INPUT_AND_CAMERA_WRAP_PASS")
	quit()

func send_key(key: Key, pressed: bool) -> void:
	var event := InputEventKey.new()
	event.keycode = key
	event.physical_keycode = key
	event.pressed = pressed
	Input.parse_input_event(event)

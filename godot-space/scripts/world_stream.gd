extends Node3D

const Torus = preload("res://scripts/torus.gd")
const Builder = preload("res://scripts/voxel_mesh_builder.gd")
const SOLID_RADIUS := 285.0
const MICRO_RADIUS := 155.0
const HYSTERESIS := 85.0
var far: Dictionary = {}
var loaded: Dictionary = {}
var jobs: Array[Dictionary] = []
var wanted: Array[Dictionary] = []
var desired: Dictionary = {}
var shared_material := Builder.material()
var logical_camera := Vector3(8192.5, 180, 1024.5)
var overview := false
var refresh_elapsed := 1.0
var published := 0
var cubes := VoxelMesherCubes.new()

func _ready() -> void:
	cubes.greedy_meshing_enabled = true
	var scene: Node3D = load("res://baked/torus-far.scn").instantiate()
	add_child(scene)
	for child in scene.get_children():
		far[String(child.name).trim_prefix("Far_")] = child

func set_view(point: Vector3, full_ring_view: bool) -> void:
	logical_camera = point
	if overview != full_ring_view:
		refresh_elapsed = 1.0
	overview = full_ring_view

func _process(delta: float) -> void:
	refresh_elapsed += delta
	if refresh_elapsed >= 0.35:
		refresh_elapsed = 0.0
		refresh_requests()
	# Rendering RIDs stay on the main thread; bound native chunk meshing to 2 ms.
	var meshing_started := Time.get_ticks_usec()
	for job in jobs:
		if job.phase != "meshing": continue
		while not job.prepared.is_empty() and Time.get_ticks_usec() - meshing_started < 2000:
			job.surfaces.append_array(Builder.extract(job.prepared.pop_front(), cubes))
		if job.prepared.is_empty():
			job.phase = "projecting"
			job.task = WorkerThreadPool.add_task(project_job.bind(job), false, "Bend " + job.id)
	# Workers only return detached buffers/arrays. Publish one sector per frame.
	for i in range(jobs.size() - 1, -1, -1):
		var job: Dictionary = jobs[i]
		if job.phase == "meshing": continue
		if not WorkerThreadPool.is_task_completed(job.task):
			continue
		WorkerThreadPool.wait_for_task_completion(job.task)
		job.task = -1
		if job.phase == "preparing" and desired.has(job.id):
			job.phase = "meshing"
			continue
		jobs.remove_at(i)
		if desired.has(job.id):
			var instance := MeshInstance3D.new()
			instance.mesh = Builder.mesh_from_arrays(job.arrays, shared_material)
			instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
			instance.name = job.id.replace(":", "_")
			add_child(instance)
			loaded[job.id] = {"node": instance, "x": job.x, "z": job.z, "kind": job.kind}
			if job.kind == "solid":
				far["%d_%d" % [job.x, job.z]].visible = false
			published += 1
		break
	while jobs.size() < 2 and not wanted.is_empty():
		var request: Dictionary = wanted.pop_front()
		if loaded.has(request.id) or pending(request.id) or not desired.has(request.id):
			continue
		if request.kind == "micro" and not loaded.has("solid:%d_%d" % [request.x, request.z]):
			continue
		var job: Dictionary = request.duplicate()
		job.arrays = []
		job.prepared = []
		job.surfaces = []
		job.phase = "preparing"
		job.task = -1
		job.task = WorkerThreadPool.add_task(build_job.bind(job), false, "Aether " + job.id)
		jobs.append(job)

func pending(id: String) -> bool:
	for job in jobs:
		if job.id == id: return true
	return false

func refresh_requests() -> void:
	wanted.clear()
	desired.clear()
	if not overview and logical_camera.y < 520:
		var cx := int(floor(logical_camera.x / 128.0))
		var cz := int(floor(logical_camera.z / 128.0))
		for dz in range(-3, 4):
			for dx in range(-3, 4):
				var x := posmod(cx + dx, 128)
				var z := posmod(cz + dz, 16)
				var distance := Torus.sector_distance(x, z, logical_camera)
				for kind in ["solid", "micro"]:
					var id := "%s:%d_%d" % [kind, x, z]
					var radius := SOLID_RADIUS if kind == "solid" else MICRO_RADIUS
					if loaded.has(id): radius += HYSTERESIS
					if distance > radius: continue
					desired[id] = true
					if not loaded.has(id) and not pending(id):
						wanted.append({"id": id, "x": x, "z": z, "kind": kind,
							"priority": distance + (500.0 if kind == "micro" else 0.0)})
	wanted.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a.priority < b.priority)
	for id in loaded.keys():
		if desired.has(id): continue
		var record: Dictionary = loaded[id]
		if record.kind == "solid":
			far["%d_%d" % [record.x, record.z]].visible = true
		record.node.queue_free()
		loaded.erase(id)

func build_job(job: Dictionary) -> void:
	var neighbours := []
	var center: Dictionary = {}
	for dz in range(-1, 2):
		for dx in range(-1, 2):
			var x := posmod(int(job.x) + dx, 128)
			var z := posmod(int(job.z) + dz, 16)
			var sector: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://world-data/sectors/%d_%d.json" % [x, z]))
			neighbours.append(sector)
			if dx == 0 and dz == 0: center = sector
	var builder := Builder.new(neighbours)
	job.prepared = builder.prepare(center.records, job.kind)

func project_job(job: Dictionary) -> void:
	job.arrays = Builder.project(job.surfaces)
	job.surfaces = []

func statistics() -> Dictionary:
	var solid := 0
	var micro := 0
	for item in loaded.values():
		if item.kind == "solid": solid += 1
		else: micro += 1
	return {"farSectors": far.size(), "solidSectors": solid, "microSectors": micro,
		"pendingJobs": jobs.size(), "queuedJobs": wanted.size(), "published": published}

func _exit_tree() -> void:
	for job in jobs:
		if job.task >= 0:
			WorkerThreadPool.wait_for_task_completion(job.task)

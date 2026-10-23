// Three.js r183 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_1570916Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_1570916 : NodeBuffer_1570916Struct;

struct NodeBuffer_1570915Struct {
	value : array< vec4<u32> >
};
@binding( 4 ) @group( 1 )
var<storage, read> NodeBuffer_1570915 : NodeBuffer_1570915Struct;

struct NodeBuffer_273213Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_273213 : NodeBuffer_273213Struct;

struct NodeBuffer_273214Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_273214 : NodeBuffer_273214Struct;

struct objectStruct {
	nodeUniform1 : f32,
	nodeUniform6 : mat3x3<f32>,
	nodeUniform7 : vec3<f32>,
	nodeUniform8 : f32,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : f32,
	nodeUniform12 : vec3<f32>,
	nodeUniform13 : f32,
	nodeUniform21 : mat4x4<f32>,
	nodeUniform25 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform15 : vec3<f32>,
	nodeUniform17 : vec3<f32>,
	nodeUniform14 : vec3<f32>,
	nodeUniform20 : vec3<f32>,
	nodeUniform18 : vec3<f32>,
	nodeUniform19 : vec3<f32>,
	nodeUniform23 : vec3<f32>,
	nodeUniform24 : f32
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// varyings

struct VaryingsStruct {
	@location( 2 ) v_positionView : vec3<f32>,
	@location( 3 ) nodeVarying3 : vec3<f32>,
	@location( 4 ) v_positionViewDirection : vec3<f32>,
	@location( 5 ) nodeVarying5 : f32,
	@location( 7 ) spaceTorusNormal : vec3<f32>,
	@invariant @builtin( position ) builtinClipSpace : vec4<f32>
};
var<private> varyings : VaryingsStruct;

// codes
fn tsl_mod_float( x : f32, y : f32 ) -> f32 { return x - y * floor( x / y ); }
fn voxelArenaColor ( value: u32 ) -> vec3<f32> { return unpack4x8unorm(value).xyz; }



@vertex
fn main( @builtin( vertex_index ) vertexIndex : u32,
	@builtin( instance_index ) instanceIndex : u32 ) -> VaryingsStruct {

	// vars
	
	var nodeVar0 : vec3<f32>;
	var nodeVar1 : u32;
	var nodeVar2 : u32;
	var nodeVar3 : u32;
	var nodeVar4 : vec4<f32>;
	var nodeVar5 : u32;
	var nodeVar6 : vec2<f32>;
	var nodeVar7 : f32;
	var nodeVar8 : vec4<u32>;
	var nodeVar9 : vec3<f32>;
	var nodeVar10 : vec2<f32>;
	var nodeVar11 : vec3<f32>;
	var nodeVar12 : vec2<f32>;
	var nodeVar13 : vec2<f32>;
	var nodeVar14 : vec3<f32>;
	var nodeVar15 : vec4<f32>;
	var nodeVar16 : vec4<f32>;
	var nodeVar17 : f32;
	var nodeVar18 : vec3<f32>;
	var nodeVar19 : vec3<f32>;
	var nodeVar20 : f32;
	var nodeVar21 : vec3<f32>;
	var nodeVar22 : vec3<f32>;
	var nodeVar23 : vec3<f32>;
	var modelViewMatrix : mat4x4<f32>;
	var VERTEX_nodeVar133 : vec4<f32>;
	var positionLocal : vec3<f32>;
	var v_modelViewProjection : vec4<f32>;
	var VERTEX_v_modelViewProjection : vec4<f32>;


	// flow
	// code

	positionLocal = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar1 = ( ( vertexIndex / 4u ) + ( instanceIndex * 16u ) );
	nodeVar2 = ( nodeVar1 % 16u );
	nodeVar3 = ( ( ( nodeVar1 / 16u ) + u32( object.nodeUniform1 ) ) * 2u );
	nodeVar4 = NodeBuffer_1570916.value[ nodeVar3 ];

	if ( ( nodeVar2 < u32( nodeVar4.y ) ) ) {

		nodeVar5 = ( vertexIndex % 4u );
		nodeVar6 = vec2<f32>( f32( ( ( f32( nodeVar5 ) == 1.0 ) || ( f32( nodeVar5 ) == 2.0 ) ) ), f32( ( f32( nodeVar5 ) >= 2.0 ) ) );
		nodeVar8 = NodeBuffer_1570915.value[ ( u32( nodeVar4.x ) + u32( min( f32( nodeVar2 ), ( nodeVar4.y - 1.0 ) ) ) ) ];

		if ( ( tsl_mod_float( f32( ( ( nodeVar8.z >> 16u ) & 255u ) ), 2.0 ) < 0.5 ) ) {

			nodeVar7 = ( 1.0 - nodeVar6.x );

		} else {

			nodeVar7 = nodeVar6.x;

		}

		nodeVar6.x = nodeVar7;

		if ( ( f32( ( ( nodeVar8.z >> 16u ) & 255u ) ) < 2.0 ) ) {

			nodeVar10 = ( ( nodeVar6 * vec3<f32>( f32( ( nodeVar8.y >> 16u ) ), f32( ( nodeVar8.z & 65535u ) ), 0.0 ).xy ) * vec2<f32>( 0.125 ) );
			nodeVar9 = vec3<f32>( 0.0, nodeVar10.x, nodeVar10.y );

		} else {


			if ( ( f32( ( ( nodeVar8.z >> 16u ) & 255u ) ) < 4.0 ) ) {

				nodeVar12 = ( ( nodeVar6 * vec3<f32>( f32( ( nodeVar8.y >> 16u ) ), f32( ( nodeVar8.z & 65535u ) ), 0.0 ).xy ) * vec2<f32>( 0.125 ) );
				nodeVar11 = vec3<f32>( nodeVar12.y, 0.0, nodeVar12.x );

			} else {

				nodeVar13 = ( ( nodeVar6 * vec3<f32>( f32( ( nodeVar8.y >> 16u ) ), f32( ( nodeVar8.z & 65535u ) ), 0.0 ).xy ) * vec2<f32>( 0.125 ) );
				nodeVar11 = vec3<f32>( nodeVar13.x, nodeVar13.y, 0.0 );

			}

			nodeVar9 = nodeVar11;

		}

		nodeVar0 = ( ( vec3<f32>( nodeVar4.z, nodeVar4.w, NodeBuffer_1570916.value[ ( nodeVar3 + 1u ) ].x ) + ( vec3<f32>( f32( ( nodeVar8.x & 65535u ) ), f32( ( nodeVar8.x >> 16u ) ), f32( ( nodeVar8.y & 65535u ) ) ) * vec3<f32>( 0.125 ) ) ) + nodeVar9 );

	} else {

		nodeVar0 = vec3<f32>( 0.0, 0.0, 0.0 );

	}

	nodeVar14 = nodeVar0;
	nodeVar15 = NodeBuffer_273213.value[ u32( ( i32( nodeVar14.x ) & 16383 ) ) ];
	nodeVar16 = NodeBuffer_273214.value[ u32( ( i32( nodeVar14.z ) & 2047 ) ) ];
	nodeVar17 = min( ( 325.94932345220167 + ( ( ( nodeVar14.y - 16.0 ) * ( 2607.5945876176133 + ( nodeVar16.x * 325.94932345220167 ) ) ) / 2607.5945876176133 ) ), 2606.5945876176133 );

	if ( ( f32( ( ( nodeVar8.z >> 16u ) & 255u ) ) < 2.0 ) ) {

		nodeVar18 = vec3<f32>( 1.0, 0.0, 0.0 );

	} else {

		nodeVar8 = NodeBuffer_1570915.value[ ( u32( nodeVar4.x ) + u32( min( f32( nodeVar2 ), ( nodeVar4.y - 1.0 ) ) ) ) ];

		if ( ( f32( ( ( nodeVar8.z >> 16u ) & 255u ) ) < 4.0 ) ) {

			nodeVar19 = vec3<f32>( 0.0, 1.0, 0.0 );

		} else {

			nodeVar19 = vec3<f32>( 0.0, 0.0, 1.0 );

		}

		nodeVar18 = nodeVar19;

	}

	varyings.spaceTorusNormal = normalize( ( render.cameraViewMatrix * vec4<f32>( ( mat3x3<f32>( vec3<f32>( ( - nodeVar15.y ), 0.0, nodeVar15.x ), vec3<f32>( ( nodeVar16.x * nodeVar15.x ), nodeVar16.y, ( nodeVar16.x * nodeVar15.y ) ), vec3<f32>( ( - ( nodeVar16.y * nodeVar15.x ) ), nodeVar16.x, ( - ( nodeVar16.y * nodeVar15.y ) ) ) ) * ( nodeVar18 * vec3<f32>( ( ( tsl_mod_float( f32( ( ( nodeVar8.z >> 16u ) & 255u ) ), 2.0 ) * 2.0 ) - 1.0 ) ) ) ), 0.0 ) ).xyz );
	nodeVar20 = ( 2607.5945876176133 + ( nodeVar17 * nodeVar16.x ) );
	nodeVar21 = vec3<f32>( ( nodeVar20 * nodeVar15.x ), ( nodeVar17 * nodeVar16.y ), ( nodeVar20 * nodeVar15.y ) );
	nodeVar22 = ( nodeVar21 - object.nodeUniform7 );
	positionLocal = ( nodeVar21 + ( ( ( object.nodeUniform6 * nodeVar22 ) - nodeVar22 ) * vec3<f32>( ( ( 1.0 - smoothstep( 96.0, 256.0, length( nodeVar22 ) ) ) * object.nodeUniform8 ) ) ) );
	nodeVar23 = voxelArenaColor( nodeVar8.w );
	varyings.nodeVarying3 = nodeVar23;
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform21 );
	varyings.v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - varyings.v_positionView );
	varyings.nodeVarying5 = f32( ( nodeVar8.z >> 24u ) );
	VERTEX_nodeVar133 = ( render.cameraProjectionMatrix * vec4<f32>( varyings.v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar133;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}

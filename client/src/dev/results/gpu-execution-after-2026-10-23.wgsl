// Three.js r183 - Node System

// directives


// structs


// uniforms

struct NodeBuffer_2160583Struct {
	value : array< vec4<f32> >
};
@binding( 3 ) @group( 1 )
var<storage, read> NodeBuffer_2160583 : NodeBuffer_2160583Struct;

struct NodeBuffer_2160582Struct {
	value : array< vec4<u32> >
};
@binding( 4 ) @group( 1 )
var<storage, read> NodeBuffer_2160582 : NodeBuffer_2160582Struct;

struct NodeBuffer_273231Struct {
	value : array< vec4<f32> >
};
@binding( 5 ) @group( 1 )
var<storage, read> NodeBuffer_273231 : NodeBuffer_273231Struct;

struct NodeBuffer_273232Struct {
	value : array< vec4<f32> >
};
@binding( 6 ) @group( 1 )
var<storage, read> NodeBuffer_273232 : NodeBuffer_273232Struct;

struct objectStruct {
	nodeUniform0 : f32,
	nodeUniform2 : f32,
	nodeUniform7 : mat3x3<f32>,
	nodeUniform8 : vec3<f32>,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : f32,
	nodeUniform12 : f32,
	nodeUniform13 : vec3<f32>,
	nodeUniform14 : f32,
	nodeUniform22 : mat4x4<f32>,
	nodeUniform26 : f32
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform16 : vec3<f32>,
	nodeUniform18 : vec3<f32>,
	nodeUniform15 : vec3<f32>,
	nodeUniform21 : vec3<f32>,
	nodeUniform19 : vec3<f32>,
	nodeUniform20 : vec3<f32>,
	nodeUniform24 : vec3<f32>,
	nodeUniform25 : f32
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
	var nodeVar4 : vec2<f32>;
	var nodeVar5 : f32;
	var nodeVar6 : vec3<f32>;
	var nodeVar7 : vec2<f32>;
	var nodeVar8 : vec3<f32>;
	var nodeVar9 : vec2<f32>;
	var nodeVar10 : vec2<f32>;
	var nodeVar11 : vec3<f32>;
	var nodeVar12 : vec4<f32>;
	var nodeVar13 : vec4<f32>;
	var nodeVar14 : f32;
	var nodeVar15 : vec3<f32>;
	var nodeVar16 : vec3<f32>;
	var nodeVar17 : f32;
	var nodeVar18 : vec3<f32>;
	var nodeVar19 : vec3<f32>;
	var nodeVar20 : vec3<f32>;
	var modelViewMatrix : mat4x4<f32>;
	var VERTEX_nodeVar130 : vec4<f32>;
	var positionLocal : vec3<f32>;
	var v_modelViewProjection : vec4<f32>;
	var VERTEX_v_modelViewProjection : vec4<f32>;


	// flow
	// code

	positionLocal = vec3<f32>( 0.0, 0.0, 0.0 );
	nodeVar1 = ( ( vertexIndex / 4u ) + ( instanceIndex * 32u ) );
	nodeVar2 = ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) % 16u );

	if ( ( ( nodeVar2 < u32( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) ) ) && ( f32( nodeVar1 ) < object.nodeUniform0 ) ) ) {

		nodeVar3 = ( vertexIndex % 4u );
		nodeVar4 = vec2<f32>( f32( ( ( f32( nodeVar3 ) == 1.0 ) || ( f32( nodeVar3 ) == 2.0 ) ) ), f32( ( f32( nodeVar3 ) >= 2.0 ) ) );

		if ( ( tsl_mod_float( f32( ( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 16u ) & 255u ) ), 2.0 ) < 0.5 ) ) {

			nodeVar5 = ( 1.0 - nodeVar4.x );

		} else {

			nodeVar5 = nodeVar4.x;

		}

		nodeVar4.x = nodeVar5;

		if ( ( f32( ( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 16u ) & 255u ) ) < 2.0 ) ) {

			nodeVar7 = ( ( nodeVar4 * vec3<f32>( f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].y >> 16u ) ), f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z & 65535u ) ), 0.0 ).xy ) * vec2<f32>( 0.125 ) );
			nodeVar6 = vec3<f32>( 0.0, nodeVar7.x, nodeVar7.y );

		} else {


			if ( ( f32( ( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 16u ) & 255u ) ) < 4.0 ) ) {

				nodeVar9 = ( ( nodeVar4 * vec3<f32>( f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].y >> 16u ) ), f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z & 65535u ) ), 0.0 ).xy ) * vec2<f32>( 0.125 ) );
				nodeVar8 = vec3<f32>( nodeVar9.y, 0.0, nodeVar9.x );

			} else {

				nodeVar10 = ( ( nodeVar4 * vec3<f32>( f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].y >> 16u ) ), f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z & 65535u ) ), 0.0 ).xy ) * vec2<f32>( 0.125 ) );
				nodeVar8 = vec3<f32>( nodeVar10.x, nodeVar10.y, 0.0 );

			}

			nodeVar6 = nodeVar8;

		}

		nodeVar0 = ( ( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].yzw + ( vec3<f32>( f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].x & 65535u ) ), f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].x >> 16u ) ), f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].y & 65535u ) ) ) * vec3<f32>( 0.125 ) ) ) + nodeVar6 );

	} else {

		nodeVar0 = vec3<f32>( 0.0, 0.0, 0.0 );

	}

	nodeVar11 = nodeVar0;
	nodeVar12 = NodeBuffer_273231.value[ u32( ( i32( nodeVar11.x ) & 16383 ) ) ];
	nodeVar13 = NodeBuffer_273232.value[ u32( ( i32( nodeVar11.z ) & 2047 ) ) ];
	nodeVar14 = min( ( 325.94932345220167 + ( ( ( nodeVar11.y - 16.0 ) * ( 2607.5945876176133 + ( nodeVar13.x * 325.94932345220167 ) ) ) / 2607.5945876176133 ) ), 2606.5945876176133 );

	if ( ( f32( ( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 16u ) & 255u ) ) < 2.0 ) ) {

		nodeVar15 = vec3<f32>( 1.0, 0.0, 0.0 );

	} else {


		if ( ( f32( ( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 16u ) & 255u ) ) < 4.0 ) ) {

			nodeVar16 = vec3<f32>( 0.0, 1.0, 0.0 );

		} else {

			nodeVar16 = vec3<f32>( 0.0, 0.0, 1.0 );

		}

		nodeVar15 = nodeVar16;

	}

	varyings.spaceTorusNormal = normalize( ( render.cameraViewMatrix * vec4<f32>( ( mat3x3<f32>( vec3<f32>( ( - nodeVar12.y ), 0.0, nodeVar12.x ), vec3<f32>( ( nodeVar13.x * nodeVar12.x ), nodeVar13.y, ( nodeVar13.x * nodeVar12.y ) ), vec3<f32>( ( - ( nodeVar13.y * nodeVar12.x ) ), nodeVar13.x, ( - ( nodeVar13.y * nodeVar12.y ) ) ) ) * ( nodeVar15 * vec3<f32>( ( ( tsl_mod_float( f32( ( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 16u ) & 255u ) ), 2.0 ) * 2.0 ) - 1.0 ) ) ) ), 0.0 ) ).xyz );
	nodeVar17 = ( 2607.5945876176133 + ( nodeVar14 * nodeVar13.x ) );
	nodeVar18 = vec3<f32>( ( nodeVar17 * nodeVar12.x ), ( nodeVar14 * nodeVar13.y ), ( nodeVar17 * nodeVar12.y ) );
	nodeVar19 = ( nodeVar18 - object.nodeUniform8 );
	positionLocal = ( nodeVar18 + ( ( ( object.nodeUniform7 * nodeVar19 ) - nodeVar19 ) * vec3<f32>( ( ( 1.0 - smoothstep( 96.0, 256.0, length( nodeVar19 ) ) ) * object.nodeUniform9 ) ) ) );
	nodeVar20 = voxelArenaColor( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].w );
	varyings.nodeVarying3 = nodeVar20;
	modelViewMatrix = ( render.cameraViewMatrix * object.nodeUniform22 );
	varyings.v_positionView = ( modelViewMatrix * vec4<f32>( positionLocal, 1.0 ) ).xyz;
	varyings.v_positionViewDirection = ( - varyings.v_positionView );
	varyings.nodeVarying5 = f32( ( NodeBuffer_2160582.value[ ( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) >> 5u ) + u32( min( f32( nodeVar2 ), ( f32( ( u32( NodeBuffer_2160583.value[ ( ( ( u32( min( f32( nodeVar1 ), ( object.nodeUniform0 - 1.0 ) ) ) / 16u ) + u32( object.nodeUniform2 ) ) * 1u ) ].x ) & 31u ) ) - 1.0 ) ) ) ) ].z >> 24u ) );
	VERTEX_nodeVar130 = ( render.cameraProjectionMatrix * vec4<f32>( varyings.v_positionView, 1.0 ) );
	VERTEX_v_modelViewProjection = VERTEX_nodeVar130;

	// result

	varyings.builtinClipSpace = VERTEX_v_modelViewProjection;

	return varyings;

}

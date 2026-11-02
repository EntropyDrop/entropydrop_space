#include <metal_stdlib>
using namespace metal;
// Equations/presets ported from TorusWorld, CinematicSky, CinematicEffects and Three AgX.
struct Face { packed_float3 origin; uint color; float2 extent; uint axis; uint padding; };
struct Draw { float4 origin; uint4 counts; };
struct Uniforms { float4x4 clip; float4x4 model; float4 camera; float4 options; };
struct Frame { float4x4 inverse_direction_clip, correction, shadow, inverse_projection; float4 eye, up, east, north, sun, fill, resolution; };
#ifndef PACKED_VARYINGS
#define PACKED_VARYINGS 0
#endif
#ifndef UNMASKED_TERRAIN
#define UNMASKED_TERRAIN 0
#endif
#if PACKED_VARYINGS
// Distant faces carry their original 8-bit color and material flags, losslessly.
// Decode once per shaded fragment instead of exporting/interpolating six
// floating-point color/material components for every transformed vertex.
struct Out { float4 position [[position]]; float3 world, normal;
#if !UNMASKED_TERRAIN
float2 mask;
#endif
uint2 surface [[flat]]; };
#else
struct Out { float4 position [[position]]; float3 color, world, normal; float2 mask; float alpha, emission, smooth_normal; };
#endif
float3 linear_rgb(float3 c) { return select(c/12.92,pow((c+0.055)/1.055,float3(2.4)),c>0.04045); }
float3 srgb(float3 c) { return select(12.92*c,1.055*pow(max(c,0.0),float3(1.0/2.4))-.055,c>.0031308); }
// Terrain vertices are on the 1/8 m lattice. Tables use f64-generated periodic
// angles, eliminating per-vertex atan/sin/cos and improving seam precision.
float3x3 torus(float3 p,constant Uniforms &u,device const float2 *xt,device const float2 *zt,thread float3 &bent) {
    float2 q=p.xz*8;int2 index=int2(floor(q));
    float2 theta=xt[uint(index.x)&131071],phi=zt[uint(index.y)&16383];
    if(u.options.z<.5){theta=mix(theta,xt[uint(index.x+1)&131071],fract(q.x));phi=mix(phi,zt[uint(index.y+1)&16383],fract(q.y));}
    const float R=2607.5945876176133,r=325.94932345220167;
    float rho=min(r+(p.y-16)*(1+r*phi.x/R),R-1);
    bent=float3((R+rho*phi.x)*theta.x,rho*phi.y,(R+rho*phi.x)*theta.y);
    return float3x3(float3(-theta.y,0,theta.x),float3(phi.x*theta.x,phi.y,phi.x*theta.y),float3(-phi.y*theta.x,phi.x,-phi.y*theta.y));
}
Out face_vertex(uint vid,Face face,constant Uniforms &u,constant Frame &f,device const float2 *xt,device const float2 *zt) {
    const float2 corners[4]={float2(0,0),float2(1,0),float2(0,1),float2(1,1)};
    uint d=face.axis/2,a=(d+1)%3,b=(d+2)%3;
    float3 p=float3(face.origin);p[a]+=(face.axis%2?corners[vid].x:1-corners[vid].x)*face.extent.x;p[b]+=corners[vid].y*face.extent.y;
    p=(u.model*float4(p,1)).xyz;
    float3 n=float3(0);n[d]=face.axis%2?1:-1;n=normalize((u.model*float4(n,0)).xyz);
    Out o;o.world=p;o.normal=n;
    if(u.options.x>.5){float3 bent;float3x3 basis=torus(p,u,xt,zt,bent);o.normal=basis*n;
        float3 delta=bent-f.eye.xyz;o.world=bent+((f.correction*float4(delta,0)).xyz-delta)*(1-smoothstep(96.0,256.0,length(delta)));}
#if PACKED_VARYINGS
    o.surface=uint2(face.color,face.padding);
#else
    float3 rgb=float3((face.color>>16)&255,(face.color>>8)&255,face.color&255)/255.0;o.color=(face.padding&2)?rgb:linear_rgb(rgb);
    uint material=(face.color>>24)-1;o.alpha=material>=2?1.0-float(material-1)/100.0:1.0;o.emission=material==1?1:0;
    // 1 = terrain normal + coverage mask, 2 = analytic avatar normal only.
    o.smooth_normal=(face.padding&1)?1:((face.padding&4)?2:0);
    if(material==1){o.color=linear_rgb(rgb);o.color*=.65/max(dot(o.color,float3(.2126,.7152,.0722)),.000001);}
#endif
#if !UNMASKED_TERRAIN
    o.mask=float2(-1);if(face.padding&1)o.mask=(p-n*.01).xz;
#endif
    o.position=u.clip*float4(o.world,1);return o;
}
// Stable, ordered block indirection preserves depth ties and material order.
// Coordinates are decoded exactly on the original 1/8 m lattice.
Out draw_face_vertex(uint v,uint i,device const uint *data,constant Uniforms &u,constant Frame &f,device const float2 *xt,device const float2 *zt,constant Draw &draw,device const uint *blocks,bool shadow) {
    uint index=i*draw.counts.z+v/4;v=v%4;
    if(index>=draw.counts.y){Out empty={};empty.position=float4(2,2,2,1);return empty;}
    if(draw.counts.w&2)index=blocks[index/16]*16+index%16;
    if(index>=draw.counts.x){Out empty={};empty.position=float4(2,2,2,1);return empty;}
    Face face;
    if(draw.counts.w&1){uint4 p=((device const uint4*)data)[index];face.origin=packed_float3(draw.origin.xyz+float3(p.x&65535,p.x>>16,p.y&65535)*.125);face.extent=float2(p.y>>16,p.z&65535)*.125;face.axis=(p.z>>16)&7;face.padding=p.z>>19;face.color=p.w;}
    else face=((device const Face*)data)[index];
    Out o=face_vertex(v,face,u,f,xt,zt);if(shadow)o.position=f.shadow*float4(o.world,1);return o;
}
vertex Out voxel_vertex(uint v [[vertex_id]],uint i [[instance_id]],device const uint *faces [[buffer(0)]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]],device const float2 *xt [[buffer(3)]],device const float2 *zt [[buffer(4)]],constant Draw &draw [[buffer(5)]],device const uint *blocks [[buffer(6)]]) {return draw_face_vertex(v,i,faces,u,f,xt,zt,draw,blocks,false);}
vertex Out shadow_vertex(uint v [[vertex_id]],uint i [[instance_id]],device const uint *faces [[buffer(0)]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]],device const float2 *xt [[buffer(3)]],device const float2 *zt [[buffer(4)]],constant Draw &draw [[buffer(5)]],device const uint *blocks [[buffer(6)]]) {return draw_face_vertex(v,i,faces,u,f,xt,zt,draw,blocks,true);}
struct ReplayVertex { packed_float3 position; packed_float3 color; packed_float2 mask; };
// Keep the previous direct-load vertex path as a diagnostic baseline, without
// compact decoding / map lookup branches inflating the "before" GPU time.
vertex Out legacy_vertex(uint v [[vertex_id]],uint i [[instance_id]],device const Face *faces [[buffer(0)]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]],device const float2 *xt [[buffer(3)]],device const float2 *zt [[buffer(4)]]) {return face_vertex(v,faces[i],u,f,xt,zt);}
vertex Out legacy_shadow_vertex(uint v [[vertex_id]],uint i [[instance_id]],device const Face *faces [[buffer(0)]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]],device const float2 *xt [[buffer(3)]],device const float2 *zt [[buffer(4)]]) {Out o=face_vertex(v,faces[i],u,f,xt,zt);o.position=f.shadow*float4(o.world,1);return o;}
#if !PACKED_VARYINGS
vertex Out replay_vertex(uint v [[vertex_id]],device const ReplayVertex *vertices [[buffer(0)]],constant Uniforms &u [[buffer(1)]]) {
    ReplayVertex p=vertices[v];Out o;o.world=p.position;o.position=u.clip*float4(o.world,1);o.color=p.color;o.mask=p.mask;o.alpha=1;o.emission=0;o.smooth_normal=0;o.normal=float3(0);return o;
}
vertex Out replay_shadow_vertex(uint v [[vertex_id]],device const ReplayVertex *vertices [[buffer(0)]],constant Frame &f [[buffer(2)]]) {
    Out o;o.world=vertices[v].position;o.position=f.shadow*float4(o.world,1);o.mask=vertices[v].mask;o.smooth_normal=0;return o;
}
#endif
void apply_mask(float2 uv,texture2d<float> mask) {constexpr sampler nearest(coord::normalized,address::clamp_to_edge,filter::nearest);if(uv.x>=0){float2 m=mask.sample(nearest,uv).rg;if(max(m.r,m.g)>.5)discard_fragment();}}
float surface_kind(Out in) {
#if PACKED_VARYINGS
    return (in.surface.y&1)?1:((in.surface.y&4)?2:0);
#else
    return in.smooth_normal;
#endif
}
float2 mask_uv(Out in){
#if UNMASKED_TERRAIN
    return float2(-1);
#else
    float kind=surface_kind(in);if(kind>.5&&kind<1.5){float2 p=in.mask-floor(in.mask/float2(16384,2048))*float2(16384,2048);return (floor(p/16)+.5)/float2(1024,128);}return in.mask;
#endif
}
fragment void replay_shadow_fragment(Out in [[stage_in]],texture2d<float> mask [[texture(1)]]){apply_mask(mask_uv(in),mask);}
float shadow_at(float3 p,constant Frame &f,depth2d<float> shadow) {
    float4 q=f.shadow*float4(p,1);q.xyz/=q.w;float2 uv=q.xy*float2(.5,-.5)+.5;
    if(any(uv<0)||any(uv>1)||q.z<0||q.z>1)return 1;
    constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::linear,compare_func::less_equal);
    float sum=0;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++)sum+=shadow.sample_compare(s,uv+float2(x,y)*2.8125/4096.0,q.z-.12/207.5);
    return sum/9;
}
fragment float4 voxel_fragment(Out in [[stage_in]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]],depth2d<float> shadow [[texture(0)]],texture2d<float> mask [[texture(1)]]) {
#if PACKED_VARYINGS
    uint material=(in.surface.x>>24)-1;
    float alpha=material>=2?1.0-float(material-1)/100.0:1.0,emission=material==1?1:0;
    float3 rgb=float3((in.surface.x>>16)&255,(in.surface.x>>8)&255,in.surface.x&255)/255.0;
    float3 color=(in.surface.y&2)?rgb:linear_rgb(rgb);
    if(material==1){color=linear_rgb(rgb);color*=.65/max(dot(color,float3(.2126,.7152,.0722)),.000001);}
#else
    float alpha=in.alpha,emission=in.emission;float3 color=in.color;
#endif
#if !UNMASKED_TERRAIN
    apply_mask(mask_uv(in),mask);if(alpha<.005)discard_fragment();
#endif
    float3 n=normalize(cross(dfdx(in.world),dfdy(in.world)));if(dot(n,in.normal)<0)n=-n;
    if(length(in.normal)<.1&&dot(n,f.eye.xyz-in.world)<0)n=-n;
    if(surface_kind(in)>.5)n=normalize(in.normal);
    float3 c=color;
    if(u.options.y>.5&&emission<.5) {
        float hemi=dot(n,f.up.xyz)*.5+.5;
        float3 ambient=mix(linear_rgb(float3(135,156,97)/255),linear_rgb(float3(184,217,255)/255),hemi)*.85;
        float3 sunlight=linear_rgb(float3(255,223,173)/255)*3.2*shadow_at(in.world+n*.05,f,shadow);
        float3 fill=linear_rgb(float3(199,223,255)/255)*.24;
        float3 diffuse=c*.85,specular=mix(float3(.04),c,.15),view=normalize(f.eye.xyz-in.world);
        float3 result=ambient*diffuse/M_PI_F;
        for(int i=0;i<2;i++){float3 light=i==0?f.sun.xyz:f.fill.xyz,radiance=i==0?sunlight:fill;
            float nl=max(dot(n,light),0.0),nv=max(dot(n,view),0.0);float3 halfdir=normalize(light+view);
            float nh=max(dot(n,halfdir),0.0),vh=max(dot(view,halfdir),0.0),a=.65*.65,a2=a*a;
            float denom=nh*nh*(a2-1)+1,D=a2/(M_PI_F*denom*denom);
            float V=.5/max(nl*sqrt(a2+(1-a2)*nv*nv)+nv*sqrt(a2+(1-a2)*nl*nl),.000001);
            float3 F=specular+(1-specular)*exp2((-5.55473*vh-6.98316)*vh);
            result+=radiance*nl*(diffuse/M_PI_F+F*(D*V));}
        c=result;
    }
    return float4(c,alpha<.999?alpha:1+emission);
}
struct Full { float4 position [[position]]; float2 uv; };
vertex Full fullscreen(uint v [[vertex_id]]) {Full o;o.uv=float2((v<<1)&2,v&2);o.position=float4(o.uv*float2(2,-2)+float2(-1,1),1,1);return o;}
// Translation-free world direction: no large world coordinates or eye subtraction.
float3 direction_at(float2 uv,constant Frame &f){return normalize((f.inverse_direction_clip*float4(uv*float2(2,-2)+float2(-1,1),1,1)).xyz);}
float hash(float2 p){return fract(sin(dot(p,float2(127.1,311.7)))*43758.5453);}
float noise(float2 p){float2 c=floor(p),a=fract(p);a=a*a*(3-2*a);return mix(mix(hash(c),hash(c+float2(1,0)),a.x),mix(hash(c+float2(0,1)),hash(c+1),a.x),a.y);}
float fbm(float2 p){float a=0,w=.5;for(int i=0;i<5;i++){a+=noise(p)*w;p=float2(p.x*1.6+p.y*1.2,p.x*-1.2+p.y*1.6)+float2(11.3,7.1);w*=.5;}return a;}
fragment float4 sky_fragment(Full in [[stage_in]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]]) {
    if(u.options.w<.5)return float4(linear_rgb(float3(18,24,32)/255),1);
    float3 dir=direction_at(in.uv,f),sun=f.sun.xyz;float h=dot(dir,f.up.xyz),sd=max(dot(dir,sun),0.0);
    float3 c=mix(float3(.35,.58,.94),float3(.018,.09,.34),pow(max(h,0.0),.45));
    c+=float3(1,.56,.22)*pow(sd,8.0)*.26+float3(1,.69,.35)*pow(sd,96.0)*1.35+float3(1,.86,.59)*smoothstep(.99945,.99978,sd)*12;
    if(h>.015){float2 wind=float2(.008,.003)*f.resolution.z;
        float2 uv=float2(dot(dir,f.east.xyz),dot(dir,f.north.xyz))/max(h,.015)*1.65+wind;
        float broad=noise(uv*.42+13),density=fbm(uv)*.78+broad*.22,cloud=smoothstep(.48,.69,density)*smoothstep(.08,.24,h);
        float lit=fbm(uv+float2(dot(sun,f.east.xyz),dot(sun,f.north.xyz))*.16)*.78+broad*.22;
        float silver=clamp((density-lit)*7+.35,0.0,1.0);
        float3 cc=mix(float3(.38,.49,.65),float3(1.3,1.26,1.16),silver)+float3(1,.69,.36)*pow(sd,16.0)*(1-cloud)*.8;
        c=mix(c,cc,cloud*.96);float wisps=smoothstep(.62,.79,fbm(uv*float2(.5,2.4)+wind*.6+29));c=mix(c,float3(1.25,1.3,1.4),wisps*.22*smoothstep(.08,.3,h));}
    return float4(c,1);
}
constexpr sampler sample_linear(coord::normalized,address::clamp_to_edge,filter::linear);
constexpr sampler sample_nearest(coord::normalized,address::clamp_to_edge,filter::nearest);
// Reconstruct directly in view space, as the Web Ultra pass does. Going through
// kilometre-scale world coordinates causes cancellation and grainy flat surfaces.
float3 view_at(float2 uv,depth2d<float> depth,constant Frame &f){float4 p=f.inverse_projection*float4(uv*float2(2,-2)+float2(-1,1),depth.sample(sample_nearest,uv),1);return p.xyz/p.w;}
fragment float4 secondary_fragment(Full in [[stage_in]],constant Uniforms &u [[buffer(1)]],constant Frame &f [[buffer(2)]],texture2d<float> scene [[texture(0)]],depth2d<float> depth [[texture(1)]]) {
    float2 uv=in.uv,texel=1/f.resolution.xy;float3 p=view_at(uv,depth,f);float ao=1,shaft=0;
    if(depth.sample(sample_nearest,uv)<.999999&&-p.z>=.8&&-p.z<=180){
        float3 l=view_at(uv-float2(texel.x,0),depth,f),r=view_at(uv+float2(texel.x,0),depth,f),b=view_at(uv+float2(0,texel.y),depth,f),t=view_at(uv-float2(0,texel.y),depth,f);
        float3 dx=abs(l.z-p.z)<abs(r.z-p.z)?p-l:r-p,dy=abs(b.z-p.z)<abs(t.z-p.z)?p-b:t-p,n=normalize(cross(dx,dy)+float3(0,0,.0000001));
        float pixels=clamp(1.3*f.resolution.y/(-p.z*tan(35.0*M_PI_F/180.0)*2),2.0,72.0),occlusion=0;
        for(int i=0;i<16;i++){float angle=float(i)*2.399963,ring=sqrt((float(i)+.5)/16);float2 suv=uv+float2(cos(angle),sin(angle))*ring*pixels*texel;
            if(all(suv>=0)&&all(suv<=1)&&depth.sample(sample_nearest,suv)<.999999){float3 q=view_at(suv,depth,f),delta=q-p;float dist=length(delta);if(-q.z>=.8)occlusion+=max(dot(n,delta/max(dist,.0001))-.2,0.0)*(1-smoothstep(.15,1.3,dist));}}
        ao=clamp(1-occlusion*2/16,.6,1.0);
    }
    float4 sunclip=u.clip*float4(f.sun.xyz,0);
    if(sunclip.w>0){float2 sun=sunclip.xy/sunclip.w,sp=sun*float2(.5,-.5)+.5,q=uv,step=(sp-uv)*(.94/24);float decay=1,visibility=1-smoothstep(.9,1.6,max(abs(sun.x),abs(sun.y)));
        for(int i=0;i<24;i++){q+=step;if(all(q>=0)&&all(q<=1)){float proximity=max(1-length((q-sp)*float2(f.resolution.x/f.resolution.y,1))/.85,0.0);float transmission=smoothstep(.3,1.4,dot(scene.sample(sample_linear,q).rgb,float3(.2126,.7152,.0722)));shaft+=(depth.sample(sample_nearest,q)>=.999999?1:0)*proximity*proximity*decay*transmission;}decay*=.965;}shaft*=.014*visibility;}
    return float4(ao,shaft,log2(max(-p.z,0.0)+1),1);
}
fragment float4 atmosphere_fragment(Full in [[stage_in]],constant Frame &f [[buffer(2)]],texture2d<float> scene [[texture(0)]],depth2d<float> depth [[texture(1)]],texture2d<float> secondary [[texture(2)]]) {
    float4 source=scene.sample(sample_linear,in.uv);float3 c=source.rgb,p=view_at(in.uv,depth,f),ray=direction_at(in.uv,f);float coverage=clamp(source.a-1,0.0,1.0);
    float2 size=float2(secondary.get_width(),secondary.get_height()),grid=in.uv*size-.5,base=floor(grid),fraction=fract(grid);float d=log2(max(-p.z,0.0)+1),ao=0,weight=0,shaft=0;
    for(int y=0;y<2;y++)for(int x=0;x<2;x++){float2 offset=float2(x,y);float3 effect=secondary.sample(sample_nearest,(base+offset+.5)/size).rgb;float2 blend=mix(1-fraction,fraction,offset);float spatial=blend.x*blend.y,w=spatial*exp2(abs(effect.b-d)*-128);ao+=effect.r*w;weight+=w;shaft+=effect.g*spatial;}
    ao=weight>.0001?ao/weight:1;
    if(depth.sample(sample_nearest,in.uv)<.999999&&-p.z>.8){c*=mix(ao,1.0,coverage);float distance=length(p),elevation=dot(ray,f.up.xyz),mist=exp(-max(elevation*distance+12,0.0)*.012),haze=(1-exp(-distance*(mist*.0005+.00012)))*.32;float3 hc=mix(float3(.24,.40,.62),float3(.78,.58,.38),pow(max(dot(ray,f.sun.xyz),0.0),8.0));c=mix(c,hc,haze*(1-coverage));}
    float lum=dot(c,float3(.2126,.7152,.0722));c=mix(float3(lum),c,1.12);c*=mix(float3(.91,.97,1.06),float3(1.035,1.015,.96),smoothstep(.05,.9,lum));if(-p.z>.8)c+=float3(1,.72,.38)*shaft*(1-coverage);return float4(max(c,0.0),1);
}
fragment float4 bloom_extract(Full in [[stage_in]],texture2d<float> scene [[texture(0)]],texture2d<float> atmosphere [[texture(1)]]) {
    float4 src=scene.sample(sample_linear,in.uv);float3 c=atmosphere.sample(sample_linear,in.uv).rgb;float coverage=clamp(src.a-1,0.0,1.0);return float4(mix(c*smoothstep(1.5,1.51,dot(c,float3(.2126,.7152,.0722))),src.rgb*1.5/max(dot(src.rgb,float3(.2126,.7152,.0722)),.000001),coverage),1);
}
fragment float4 bloom_blur(Full in [[stage_in]],texture2d<float> source [[texture(0)]],constant float4 &p [[buffer(3)]]) {
    float3 c=float3(0);for(int i=1-int(p.z);i<int(p.z);i++){float weight=.39894/p.w*exp(-float(i*i)/(2*p.w*p.w));c+=source.sample(sample_linear,in.uv+float(i)*p.xy).rgb*weight;}return float4(c,1);
}
float3 agx(float3 c){
    const float3x3 to2020=float3x3(float3(.6274,.0691,.0164),float3(.3293,.9195,.0880),float3(.0433,.0114,.8956));
    const float3x3 from2020=float3x3(float3(1.6605,-.1246,-.0182),float3(-.5876,1.1329,-.1006),float3(-.0728,-.0083,1.1187));
    const float3x3 inset=float3x3(float3(.856627153,.137318973,.111898213),float3(.095121241,.761241991,.076799419),float3(.048251606,.101439036,.811302368));
    const float3x3 outset=float3x3(float3(1.127100582,-.141329763,-.141329763),float3(-.110606643,1.157823702,-.110606643),float3(-.016493939,-.016493939,1.251936407));
    c=inset*(to2020*(c*1.08));c=clamp((log2(max(c,1e-10))+12.47393)/16.5,0.0,1.0);float3 x2=c*c,x4=x2*x2;c=15.5*x4*x2-40.14*x4*c+31.96*x4-6.868*x2*c+.4298*x2+.1191*c-.00232;c=pow(max(outset*c,0.0),float3(2.2));return clamp(from2020*c,0.0,1.0);
}
fragment float4 output_fragment(Full in [[stage_in]],texture2d<float> source [[texture(0)]],array<texture2d<float>,5> bloom [[texture(1)]]) {
    float3 c=source.sample(sample_linear,in.uv).rgb;for(int i=0;i<5;i++){float factor=1-float(i)*.2;c+=bloom[i].sample(sample_linear,in.uv).rgb*mix(factor,1.2-factor,.15)*.06;}
    c=srgb(agx(c));c=clamp((c-.5)*1.08+.5,0.0,1.0);c=mix(float3(dot(c,float3(.2126,.7152,.0722))),c,1.12);float2 edge=in.uv*2-1;c*=1-dot(edge,edge)*.035;return float4(linear_rgb(clamp(c,0.0,1.0)),1);
}
fragment float4 copy_fragment(Full in [[stage_in]],texture2d<float> source [[texture(0)]]) {return float4(source.sample(sample_linear,in.uv).rgb,1);}
// FXAA runs after the sRGB display grade, before the native UI.
fragment float4 fxaa_fragment(Full in [[stage_in]],texture2d<float> source [[texture(0)]]) {
    float2 px=1/float2(source.get_width(),source.get_height()),uv=in.uv;
    float3 nw=srgb(source.sample(sample_linear,uv+px*float2(-1,-1)).rgb),ne=srgb(source.sample(sample_linear,uv+px*float2(1,-1)).rgb),sw=srgb(source.sample(sample_linear,uv+px*float2(-1,1)).rgb),se=srgb(source.sample(sample_linear,uv+px*float2(1,1)).rgb),m=srgb(source.sample(sample_linear,uv).rgb);
    const float3 l=float3(.299,.587,.114);float a=dot(nw,l),b=dot(ne,l),c=dot(sw,l),d=dot(se,l),e=dot(m,l),lo=min(e,min(min(a,b),min(c,d))),hi=max(e,max(max(a,b),max(c,d)));
    if(hi-lo<max(.0312,hi*.125))return float4(linear_rgb(m),1);
    float2 dir=float2(-((a+b)-(c+d)),(a+c)-(b+d));float reduce=max((a+b+c+d)*(.25*.125),1.0/128);dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+reduce),-8.0,8.0)*px;
    float3 first=.5*(srgb(source.sample(sample_linear,uv+dir*(1.0/3-.5)).rgb)+srgb(source.sample(sample_linear,uv+dir*(2.0/3-.5)).rgb));
    float3 second=first*.5+.25*(srgb(source.sample(sample_linear,uv-dir*.5).rgb)+srgb(source.sample(sample_linear,uv+dir*.5).rgb));float lum=dot(second,l);return float4(linear_rgb(lum<lo||lum>hi?first:second),1);
}
struct UiVertex { packed_float2 position; packed_float2 uv; uint color; };
struct UiOut { float4 position [[position]]; float2 uv; float4 color; };
vertex UiOut ui_vertex(uint id [[vertex_id]],device const UiVertex *vertices [[buffer(0)]],constant float2 &screen [[buffer(1)]]) {UiVertex v=vertices[id];UiOut o;o.position=float4(float2(v.position)/screen*float2(2,-2)+float2(-1,1),0,1);o.uv=v.uv;o.color=float4(v.color&255,(v.color>>8)&255,(v.color>>16)&255,(v.color>>24)&255)/255;return o;}
fragment float4 ui_fragment(UiOut in [[stage_in]],texture2d<float> atlas [[texture(0)]],sampler sampling [[sampler(0)]]) {float4 c=in.color*atlas.sample(sampling,in.uv);return float4(linear_rgb(c.rgb),c.a);}

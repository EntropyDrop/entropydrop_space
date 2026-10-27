package com.entropydrop.torus;
import net.minecraft.client.MinecraftClient;
import org.lwjgl.opengl.GL20;
import org.lwjgl.opengl.GL11;
import java.util.*;
public final class TorusShaders {
 public static final TorusMath MATH=new TorusMath();
 public static boolean enabled=false;public static int sodiumPatches,dhPatches,uploads;public static long frame;
 private record Uniforms(int flag,int camera,int origin,int inverse,int correction){}
 private static final Map<Integer,Uniforms> locations=new HashMap<>();private static final Map<Integer,Long> lastFrame=new HashMap<>();
 private static final float[] matrix=new float[9];
 public static void update(){var c=MinecraftClient.getInstance();if(c.world==null)return;var pos=c.gameRenderer.getCamera().getPos();MATH.update(pos.x,pos.y,pos.z);frame++;}
 private static final String GLSL="""
 uniform int uSpaceTorus;
 uniform vec3 uSpaceCamera,uSpaceOrigin;
 uniform mat3 uSpaceInverse,uSpaceCorrection;
 vec3 spaceTorusPosition(vec3 relativePosition){
  if(uSpaceTorus==0)return relativePosition;
  vec3 p=relativePosition+uSpaceCamera;
  float R=2607.5945876176133,r=325.94932345220167;
  float theta=p.x/R,t=p.z/r*.5,s=sin(t),c=cos(t),F=1.1338934190276817;
  float den=c*c+F*F*s*s,cp=(c*c-F*F*s*s)/den,sp=2.0*F*s*c/den;
  float rho=min(R-1.0,r+(p.y-16.0)*(R+r*cp)/R);
  vec3 bent=vec3((R+rho*cp)*cos(theta),rho*sp,(R+rho*cp)*sin(theta));
  vec3 delta=bent-uSpaceOrigin;
  float blend=1.0-smoothstep(96.0,256.0,length(delta));
  delta+=(uSpaceCorrection*delta-delta)*blend;
  return uSpaceInverse*delta;
 }
 """;
 public static String patch(String source){
  if(source.contains("vec3 position = _vert_position + translation;")){sodiumPatches++;source=source.replace("vec3 position = _vert_position + translation;","vec3 position = spaceTorusPosition(_vert_position + translation);");}
  else if(source.contains("gl_Position = uCombinedMatrix * vec4(vertexWorldPos, 1.0);")){dhPatches++;source=source.replace("gl_Position = uCombinedMatrix * vec4(vertexWorldPos, 1.0);","vertexWorldPos = spaceTorusPosition(vertexWorldPos);\n    gl_Position = uCombinedMatrix * vec4(vertexWorldPos, 1.0);");}
  else return source;
  int at=source.indexOf("void main");if(at<0)throw new IllegalStateException("Missing terrain main");return source.substring(0,at)+GLSL+source.substring(at);
 }
 public static void upload(){
  int program=GL11.glGetInteger(GL20.GL_CURRENT_PROGRAM);if(program==0)return;
  Uniforms u=locations.computeIfAbsent(program,p->new Uniforms(GL20.glGetUniformLocation(p,"uSpaceTorus"),GL20.glGetUniformLocation(p,"uSpaceCamera"),GL20.glGetUniformLocation(p,"uSpaceOrigin"),GL20.glGetUniformLocation(p,"uSpaceInverse"),GL20.glGetUniformLocation(p,"uSpaceCorrection")));
  if(u.flag<0 || Objects.equals(lastFrame.get(program),frame))return;lastFrame.put(program,frame);uploads++;
  GL20.glUniform1i(u.flag,enabled?1:0);GL20.glUniform3f(u.camera,(float)MATH.camera.x,(float)MATH.camera.y,(float)MATH.camera.z);GL20.glUniform3f(u.origin,(float)MATH.origin.x,(float)MATH.origin.y,(float)MATH.origin.z);
  for(int c=0;c<3;c++)for(int r=0;r<3;r++)matrix[c*3+r]=(float)MATH.inverseFrame.get(c,r);GL20.glUniformMatrix3fv(u.inverse,false,matrix);for(int c=0;c<3;c++)for(int r=0;r<3;r++)matrix[c*3+r]=(float)MATH.correction.get(c,r);GL20.glUniformMatrix3fv(u.correction,false,matrix);
 }
}

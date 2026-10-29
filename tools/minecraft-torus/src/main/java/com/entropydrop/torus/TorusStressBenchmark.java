package com.entropydrop.torus;

import com.google.gson.GsonBuilder;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.util.ScreenshotRecorder;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.opengl.GL11;
import java.nio.file.*;
import java.util.*;

/** Explicit stress-only fixture: common full-detail terrain and deterministic motion. */
public final class TorusStressBenchmark {
 private static final String[] ORDER={"control","dense","turn","move","move","turn","dense","control"};
 private static final int WIDTH=2560,HEIGHT=1440;
 private static boolean configured,complete,capturing;
 private static int block=-1,captureFrames,resizeAttempts;
 private static long readyAt,phaseStart,previous,nextStatus,nextResize;
 private static String terrain;
 private static List<Double> frames=new ArrayList<>(),phases=new ArrayList<>();
 private static final List<Map<String,Object>> rows=new ArrayList<>();
 private static String mode(){return block<0?"control":ORDER[block];}
 private static double effectiveFov(){return Math.toDegrees(2*Math.atan(1/TorusBenchmark.projectionY));}
 private static int fov(){return mode().equals("control")?70:100;}
 private static void status(String state)throws Exception{
  Files.writeString(Path.of("torus-stress-status.json"),new GsonBuilder().create().toJson(Map.of(
   "state",state,"block",block,"mode",mode(),"fixedSections",TorusBenchmark.fixedSections,"fixedPending",TorusBenchmark.fixedPending)));
 }
 private static void configure(MinecraftClient c)throws Exception{
  if(!Boolean.getBoolean("space_torus.benchmark") || !(c.getServer().getOverworld().getChunkManager().getChunkGenerator() instanceof TorusChunkGenerator generator))throw new IllegalStateException("Refusing non-fixture world");
  terrain=generator.terrain;TorusShaders.enabled=true;c.chunkCullingEnabled=false;
  c.options.hudHidden=true;c.options.pauseOnLostFocus=false;c.options.getFovEffectScale().setValue(0.0);c.options.getBobView().setValue(false);
  c.options.getViewDistance().setValue(8);c.options.getMaxFps().setValue(260);c.options.getEnableVsync().setValue(false);c.getWindow().setVsync(false);
  if(c.getWindow().isFullscreen())c.getWindow().toggleFullscreen();
  TorusBenchmark.set("graphics","chunkRenderDistance",576);TorusBenchmark.set("graphics","renderingEnabled",true);
  TorusBenchmark.set("worldGenerator","enableDistantWorldGeneration",false);
  TorusBenchmark.set("graphics","verticalQuality",com.seibel.distanthorizons.api.enums.config.EDhApiVerticalQuality.PIXEL_ART);
  TorusBenchmark.set("graphics","caveCullingEnabled",false);TorusBenchmark.set("graphics.fog","enableDhFog",false);TorusBenchmark.set("graphics.fog","enableVanillaFog",false);
  TorusBenchmark.set("graphics.noiseTexture","noiseEnabled",false);TorusBenchmark.set("graphics.ambientOcclusion","enabled",false);
  TorusBenchmark.fixedDetailActive=true;configured=true;
 }
 private static void pose(MinecraftClient c,double seconds){
  String mode=mode();double phase=seconds*Math.PI/3,x=8192.5,z=1024.5,yaw=0;
  if(mode.equals("move")){x+=64*Math.sin(phase);z+=32*Math.sin(phase*2);}
  if(mode.equals("turn"))yaw=90*Math.sin(phase);
  c.options.getFov().setValue(fov());c.player.getAbilities().flying=true;c.player.setNoGravity(true);
  c.player.setPosition(x,180-c.player.getStandingEyeHeight(),z);c.player.setVelocity(0,0,0);
  c.player.setYaw((float)(180-yaw));c.player.setPitch(mode.equals("control")?18:55);
  c.player.prevX=c.player.getX();c.player.prevY=c.player.getY();c.player.prevZ=c.player.getZ();c.player.prevYaw=c.player.getYaw();c.player.prevPitch=c.player.getPitch();
 }
 public static void beforeFrame(){
  if(complete)return;var c=MinecraftClient.getInstance();if(c.world==null||c.player==null)return;
  try{
   if(!configured)configure(c);long now=System.nanoTime();
   pose(c,block<0||capturing?0:(now-phaseStart)/1e9);
   if(now>=nextStatus){status(block<0?"preparing":"sampling");nextStatus=now+2_000_000_000L;}
   if(TorusPreparation.failure!=null)throw new IllegalStateException(TorusPreparation.failure);
   if(!TorusPreparation.ready)return;
   if(c.getWindow().getFramebufferWidth()!=WIDTH||c.getWindow().getFramebufferHeight()!=HEIGHT){
    if(block>=0)throw new IllegalStateException("Framebuffer changed during timing");
    if(now>=nextResize){
     if(++resizeAttempts>8)throw new IllegalStateException("Unable to establish 2560 x 1440 framebuffer");
     long handle=c.getWindow().getHandle();GLFW.glfwRestoreWindow(handle);GLFW.glfwSetWindowAttrib(handle,GLFW.GLFW_RESIZABLE,GLFW.GLFW_FALSE);
     GLFW.glfwSetWindowSizeLimits(handle,1280,720,1280,720);GLFW.glfwSetWindowPos(handle,40,60);c.getWindow().setWindowedSize(1280,720);GLFW.glfwSetWindowSize(handle,1280,720);
     nextResize=now+2_000_000_000L;
    }
    readyAt=now;return;
   }
   if(TorusBenchmark.fixedSections!=512||TorusBenchmark.fixedPending!=0){if(block>=0)throw new IllegalStateException("Fixed detail coverage changed");readyAt=now;return;}
   if(readyAt==0)readyAt=now;if(now-readyAt<60_000_000_000L)return;
   if(block<0){block=0;phaseStart=now;previous=0;return;}
   if(c.isPaused()||c.currentScreen!=null)throw new IllegalStateException("Menu or pause during timing");
   if(TorusShaders.sodiumPatches==0||TorusShaders.dhPatches==0)throw new IllegalStateException("Missing shader patch");
   double elapsed=(now-phaseStart)/1e9;
   if(elapsed>=6 && (!Double.isFinite(TorusBenchmark.projectionY)||Math.abs(effectiveFov()-fov())>.001))throw new IllegalStateException("Actual FOV mismatch");
   if(capturing){
    if(++captureFrames<4)return;
    ScreenshotRecorder.saveScreenshot(c.runDirectory,"stress-"+block+"-"+mode()+".png",c.getFramebuffer(),message->{});
    writeResult(c);block++;capturing=false;captureFrames=0;previous=0;frames=new ArrayList<>();phases=new ArrayList<>();phaseStart=System.nanoTime();
    if(block==ORDER.length){block=ORDER.length-1;complete=true;status("complete");}return;
   }
   if(elapsed>=6&&previous!=0){frames.add((now-previous)/1e6);phases.add(elapsed);}
   previous=now;
   if(elapsed>=18){
    rows.add(Map.of("block",block,"mode",mode(),"fov",fov(),"effectiveFov",effectiveFov(),"framesMs",frames,"phaseSeconds",phases,"capturePhaseSeconds",0));
    capturing=true;captureFrames=0;
   }
  }catch(Exception e){complete=true;e.printStackTrace();try{status("FAILED: "+e);}catch(Exception ignored){}}
 }
 private static void writeResult(MinecraftClient c)throws Exception{
  var data=new LinkedHashMap<String,Object>();data.put("schema","torus-stress-native-v1");data.put("terrain",terrain);
  data.put("source",TerrainData.manifest(terrain).get("sha256").getAsString());data.put("width",WIDTH);data.put("height",HEIGHT);
  data.put("fixedCellSize",1);data.put("fixedSections",TorusBenchmark.fixedSections);data.put("fixedPending",TorusBenchmark.fixedPending);data.put("fixedPositions",TorusBenchmark.fixedPositions);
  data.put("verticalQuality","PIXEL_ART");data.put("nearChunks",8);data.put("farChunks",576);data.put("warmSeconds",6);data.put("measureSeconds",12);
  data.put("glSamples",GL11.glGetInteger(org.lwjgl.opengl.GL13.GL_SAMPLES));data.put("renderer",GL11.glGetString(GL11.GL_RENDERER));data.put("glVersion",GL11.glGetString(GL11.GL_VERSION));
  data.put("mods",FabricLoader.getInstance().getAllMods().stream().map(m->m.getMetadata().getId()+"@"+m.getMetadata().getVersion()).sorted().toList());data.put("rows",rows);
  Files.writeString(Path.of("torus-stress-minecraft.json"),new GsonBuilder().create().toJson(data));
 }
}

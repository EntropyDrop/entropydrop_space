package com.entropydrop.torus;
import com.google.gson.GsonBuilder;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.rendering.v1.WorldRenderEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.util.ScreenshotRecorder;
import org.lwjgl.opengl.GL11;
import java.nio.file.*;
import java.util.*;
/** Fixed-camera, opt-in experiment. The ordinary player and physics remain flat. */
public final class TorusBenchmark implements ClientModInitializer {
 private static boolean enabled,configured,complete;private static long readyAt,phaseStart,previous,nextStatus;
 private static long nextResize;private static int resizeAttempts;
 private static int block=-1;private static String terrain;
 private static final int WARM_SECONDS=Integer.getInteger("space_torus.warmSeconds",90);
 private static final String[] ORDER={"flat","torus","across","across","torus","flat"};
 private static final List<Map<String,Object>> rows=new ArrayList<>();private static List<Double> frames=new ArrayList<>();
 @Override public void onInitializeClient(){enabled=Boolean.getBoolean("space_torus.benchmark");WorldRenderEvents.START.register(context->TorusShaders.update());}
 private static Object invoke(Object o,String name)throws Exception{return o.getClass().getMethod(name).invoke(o);}
 private static void set(String section,String key,Object value)throws Exception{
  Object configs=Class.forName("com.seibel.distanthorizons.api.DhApi$Delayed").getField("configs").get(null),config=invoke(invoke(configs,section),key);
  if(!(Boolean)config.getClass().getMethod("setValue",Object.class,String.class).invoke(config,value,"Space torus benchmark")||!Objects.equals(invoke(config,"getValue"),value))throw new IllegalStateException("DH rejected "+key);
 }
 private static void status(String state)throws Exception{Files.writeString(Path.of("torus-status.json"),new GsonBuilder().create().toJson(Map.of("state",state,"chunks",TorusPreparation.chunks,"block",block,"sodiumPatches",TorusShaders.sodiumPatches,"dhPatches",TorusShaders.dhPatches,"uploads",TorusShaders.uploads)));}
 public static void beforeFrame(){
  if(!enabled||complete)return;MinecraftClient c=MinecraftClient.getInstance();if(c.world==null||c.player==null)return;
  try{
   if(!configured){
    if(!(c.getServer().getOverworld().getChunkManager().getChunkGenerator() instanceof TorusChunkGenerator generator))throw new IllegalStateException("Refusing non-fixture world");terrain=generator.terrain;TorusShaders.enabled=true;
    c.chunkCullingEnabled=false;c.options.hudHidden=true;c.options.pauseOnLostFocus=false;c.options.getFov().setValue(70);c.options.getViewDistance().setValue(8);c.options.getMaxFps().setValue(260);c.options.getEnableVsync().setValue(false);c.getWindow().setVsync(false);
    if(c.getWindow().isFullscreen())c.getWindow().toggleFullscreen();org.lwjgl.glfw.GLFW.glfwRestoreWindow(c.getWindow().getHandle());org.lwjgl.glfw.GLFW.glfwSetWindowSize(c.getWindow().getHandle(),640,360);c.getWindow().setWindowedSize(640,360);
    set("graphics","chunkRenderDistance",576);set("graphics","renderingEnabled",true);set("worldGenerator","enableDistantWorldGeneration",false);configured=true;
   }
   boolean across=block>=0&&block<ORDER.length&&ORDER[block].equals("across");
   c.player.getAbilities().flying=true;c.player.setNoGravity(true);c.player.setPosition(8192.5,180-c.player.getStandingEyeHeight(),1024.5);c.player.setVelocity(0,0,0);c.player.setYaw(180);c.player.setPitch(across?-85:18);
   c.player.prevX=c.player.getX();c.player.prevY=c.player.getY();c.player.prevZ=c.player.getZ();c.player.prevYaw=c.player.getYaw();c.player.prevPitch=c.player.getPitch();
   long now=System.nanoTime();if(now>nextStatus){status(TorusPreparation.ready?"warming / block "+block:"preparing terrain");nextStatus=now+2_000_000_000L;}
   if(TorusPreparation.failure!=null)throw new IllegalStateException(TorusPreparation.failure);if(!TorusPreparation.ready)return;if(readyAt==0)readyAt=now;
   if(block<0 && (c.getWindow().getFramebufferWidth()!=1280||c.getWindow().getFramebufferHeight()!=720)){
    if(now>=nextResize){int[] fw={0},fh={0},ww={0},wh={0};org.lwjgl.glfw.GLFW.glfwGetFramebufferSize(c.getWindow().getHandle(),fw,fh);org.lwjgl.glfw.GLFW.glfwGetWindowSize(c.getWindow().getHandle(),ww,wh);System.out.println("SPACE_TORUS resize logical="+ww[0]+"x"+wh[0]+" actual="+fw[0]+"x"+fh[0]+" stored="+c.getWindow().getFramebufferWidth()+"x"+c.getWindow().getFramebufferHeight());if(++resizeAttempts>6)throw new IllegalStateException("Unable to establish 1280 x 720 framebuffer");org.lwjgl.glfw.GLFW.glfwRestoreWindow(c.getWindow().getHandle());org.lwjgl.glfw.GLFW.glfwSetWindowSizeLimits(c.getWindow().getHandle(),320,240,org.lwjgl.glfw.GLFW.GLFW_DONT_CARE,org.lwjgl.glfw.GLFW.GLFW_DONT_CARE);org.lwjgl.glfw.GLFW.glfwSetWindowPos(c.getWindow().getHandle(),120,120);c.getWindow().setWindowedSize(640,360);org.lwjgl.glfw.GLFW.glfwSetWindowSize(c.getWindow().getHandle(),640,360);nextResize=now+2_000_000_000L;readyAt=now;}
    return;
   }
   if(now-readyAt<WARM_SECONDS*1_000_000_000L)return;
   if(block<0)nextBlock(now);if(complete)return;
   if(TorusShaders.sodiumPatches==0||TorusShaders.dhPatches==0)throw new IllegalStateException("Terrain shader patch was not applied");
   if(c.getWindow().getFramebufferWidth()!=1280||c.getWindow().getFramebufferHeight()!=720)throw new IllegalStateException("Framebuffer mismatch "+c.getWindow().getFramebufferWidth()+" x "+c.getWindow().getFramebufferHeight());
   if(c.isPaused()||c.currentScreen!=null)throw new IllegalStateException("Menu or pause during sampling");
   double elapsed=(now-phaseStart)/1e9;if(elapsed>=5&&previous!=0)frames.add((now-previous)/1e6);previous=now;
   if(elapsed>=15){rows.add(Map.of("block",block,"mode",ORDER[block],"framesMs",frames));ScreenshotRecorder.saveScreenshot(c.runDirectory,"torus-"+block+"-"+ORDER[block]+".png",c.getFramebuffer(),message->{});writeResult(c);nextBlock(System.nanoTime());}
  }catch(Exception e){complete=true;e.printStackTrace();try{status("FAILED: "+e);}catch(Exception ignored){}}
 }
 private static void nextBlock(long now)throws Exception{block++;previous=0;frames=new ArrayList<>();phaseStart=now;if(block==ORDER.length){complete=true;status("complete");return;}TorusShaders.enabled=!ORDER[block].equals("flat");TorusShaders.frame++;}
 private static void writeResult(MinecraftClient c)throws Exception{
  var data=new LinkedHashMap<String,Object>();data.put("schema","torus-native-v1");data.put("terrain",terrain);data.put("source",TerrainData.manifest(terrain).get("sha256").getAsString());data.put("width",1280);data.put("height",720);data.put("fov",70);data.put("cameraEye",List.of(8192.5,180,1024.5));data.put("yawDegrees",180);data.put("pitchDownDegrees",Map.of("flat",18,"torus",18,"across",-85));data.put("nearChunks",8);data.put("farChunks",576);data.put("warmAfterPreparationSeconds",WARM_SECONDS);data.put("sodiumPatches",TorusShaders.sodiumPatches);data.put("dhPatches",TorusShaders.dhPatches);data.put("renderer",GL11.glGetString(GL11.GL_RENDERER));data.put("glVersion",GL11.glGetString(GL11.GL_VERSION));data.put("mods",FabricLoader.getInstance().getAllMods().stream().map(m->m.getMetadata().getId()+"@"+m.getMetadata().getVersion()).sorted().toList());data.put("rows",rows);Files.writeString(Path.of("torus-minecraft.json"),new GsonBuilder().create().toJson(data));
 }
}

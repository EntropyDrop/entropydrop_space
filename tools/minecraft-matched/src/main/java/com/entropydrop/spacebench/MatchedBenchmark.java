package com.entropydrop.spacebench;

import com.google.gson.GsonBuilder;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.util.ScreenshotRecorder;
import org.lwjgl.opengl.GL11;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** An opt-in deterministic benchmark feature of this mod, disabled in normal play. */
public final class MatchedBenchmark implements ClientModInitializer {
    private static boolean enabled, configured, complete;
    private static long readyAt, phaseStart, previous, nextStatus;
    private static int block=-1;
    private static final int WARM_SECONDS=Integer.getInteger("spacebench.warmSeconds",180);
    private static final boolean[] ORDER={true,false,false,true,false,true,true,false};
    private static final List<Map<String,Object>> rows=new ArrayList<>();
    private static List<Double> frames=new ArrayList<>();
    private static final Path OUTPUT=Path.of("matched-minecraft.json");
    @Override public void onInitializeClient(){enabled=Boolean.getBoolean("spacebench.enabled");}
    private static Object invoke(Object object,String name) throws Exception {return object.getClass().getMethod(name).invoke(object);}
    private static Object config(String section,String key) throws Exception {
        Object configs=Class.forName("com.seibel.distanthorizons.api.DhApi$Delayed").getField("configs").get(null);
        return invoke(invoke(configs,section),key);
    }
    private static void set(String section,String key,Object value) throws Exception {
        Object config=config(section,key);
        if(!(Boolean)config.getClass().getMethod("setValue",Object.class,String.class).invoke(config,value,"Space matched benchmark")) throw new IllegalStateException("DH rejected "+key);
        if(!Objects.equals(invoke(config,"getValue"),value)) throw new IllegalStateException("DH did not apply "+key);
    }
    private static void status(String value) throws Exception {Files.writeString(Path.of("matched-status.json"),new GsonBuilder().create().toJson(Map.of("state",value,"chunks",MatchedPreparation.chunks,"block",block,"width",MinecraftClient.getInstance().getWindow().getFramebufferWidth(),"height",MinecraftClient.getInstance().getWindow().getFramebufferHeight())));}
    public static void beforeFrame(){
        if(!enabled || complete) return;
        MinecraftClient c=MinecraftClient.getInstance();
        if(c.world==null || c.player==null) return;
        try {
            if(!configured){
                if(!(c.getServer().getOverworld().getChunkManager().getChunkGenerator() instanceof MatchedChunkGenerator)) throw new IllegalStateException("Refusing benchmark in a non-matched world");
                c.options.hudHidden=true;c.options.pauseOnLostFocus=false;c.options.getFov().setValue(70);
                c.options.getMaxFps().setValue(260);c.options.getEnableVsync().setValue(false);c.getWindow().setVsync(false);
                if(c.getWindow().isFullscreen())c.getWindow().toggleFullscreen();
                org.lwjgl.glfw.GLFW.glfwRestoreWindow(c.getWindow().getHandle());
                org.lwjgl.glfw.GLFW.glfwSetWindowSize(c.getWindow().getHandle(),1280,720);
                c.getWindow().setWindowedSize(640,360);
                set("graphics","chunkRenderDistance",64);set("graphics","renderingEnabled",true);
                configured=true;
            }
            c.player.getAbilities().flying=true;c.player.setNoGravity(true);
            c.player.setPosition(512.5,96-c.player.getStandingEyeHeight(),512.5);
            c.player.setVelocity(0,0,0);c.player.setYaw(180);c.player.setPitch(18);
            c.player.prevX=c.player.getX();c.player.prevY=c.player.getY();c.player.prevZ=c.player.getZ();
            c.player.prevYaw=c.player.getYaw();c.player.prevPitch=c.player.getPitch();
            long now=System.nanoTime();
            if(now>nextStatus){status(MatchedPreparation.ready?"warming LOD / block "+block:"preparing terrain");nextStatus=now+2_000_000_000L;}
            if(MatchedPreparation.failure!=null) throw new IllegalStateException(MatchedPreparation.failure);
            if(!MatchedPreparation.ready) return;
            if(readyAt==0) readyAt=now;
            if(now-readyAt<WARM_SECONDS*1_000_000_000L) return;
            if(block<0){set("worldGenerator","enableDistantWorldGeneration",false);nextBlock(now);}
            if(complete)return;
            // All variants use the same stationary camera. Keep timing free of screenshots and disk writes.
            if(c.getWindow().getFramebufferWidth()!=1280 || c.getWindow().getFramebufferHeight()!=720) throw new IllegalStateException("Framebuffer must be 1280 x 720, got "+c.getWindow().getFramebufferWidth()+" x "+c.getWindow().getFramebufferHeight());
            if(c.isPaused() || c.currentScreen!=null) throw new IllegalStateException("Sampling interrupted by a menu/pause");
            double elapsed=(now-phaseStart)/1e9;
            if(elapsed>=5 && previous!=0)frames.add((now-previous)/1e6);
            previous=now;
            if(elapsed>=15){
                rows.add(Map.of("block",block,"dh",ORDER[block],"warmSeconds",5,"sampleSeconds",10,"framesMs",frames));
                ScreenshotRecorder.saveScreenshot(c.runDirectory,"matched-"+block+"-"+(ORDER[block]?"dh":"near")+".png",c.getFramebuffer(),message->{});
                writeResult(c);nextBlock(now);
            }
        }catch(Exception e){complete=true;e.printStackTrace();try{status("FAILED: "+e);}catch(Exception ignored){}}
    }
    private static void nextBlock(long now)throws Exception{
        block++;previous=0;frames=new ArrayList<>();phaseStart=now;
        if(block==ORDER.length){complete=true;status("complete");return;}
        set("graphics","renderingEnabled",ORDER[block]);
    }
    private static void writeResult(MinecraftClient c)throws Exception{
        var data=new LinkedHashMap<String,Object>();data.put("schema","matched-native-v1");data.put("terrainCrc32","bef315c8");
        data.put("width",c.getWindow().getFramebufferWidth());data.put("height",c.getWindow().getFramebufferHeight());
        data.put("fov",70);data.put("cameraEye",List.of(512.5,96,512.5));data.put("yawDegrees",180);data.put("pitchDownDegrees",18);
        data.put("vanillaChunks",c.options.getViewDistance().getValue());data.put("dhChunks",64);data.put("warmAfterPreparationSeconds",WARM_SECONDS);
        data.put("renderer",GL11.glGetString(GL11.GL_RENDERER));data.put("glVersion",GL11.glGetString(GL11.GL_VERSION));
        data.put("mods",FabricLoader.getInstance().getAllMods().stream().map(m->m.getMetadata().getId()+"@"+m.getMetadata().getVersion()).sorted().toList());
        data.put("rows",rows);Files.writeString(OUTPUT,new GsonBuilder().create().toJson(data));
    }
}

import com.entropydrop.torus.TorusMath;
import org.joml.Vector3d;
import java.util.Scanner;
public class ProjectionCheck {
 public static void main(String[] args) {
  Scanner in=new Scanner(System.in);TorusMath math=new TorusMath();double max=0;int count=0;
  while(in.hasNextDouble()){
   double cx=in.nextDouble(),cy=in.nextDouble(),cz=in.nextDouble(),x=in.nextDouble(),y=in.nextDouble(),z=in.nextDouble();
   var expected=new Vector3d(in.nextDouble(),in.nextDouble(),in.nextDouble());math.update(cx,cy,cz);
   double error=math.relative(x,y,z,new Vector3d()).distance(expected);max=Math.max(max,error);count++;
   if(error>1e-6)throw new AssertionError("Projection differs: "+error);
  }
  System.out.println("{\"points\":"+count+",\"maxErrorMetres\":"+max+"}");
 }
}

package com.entropydrop.torus;
import org.joml.Matrix3d;
import org.joml.Vector3d;
/** Same mapping, tangent frame and 96–256 m correction as Space's TorusWorld. */
public final class TorusMath {
 public static final double R=16384/(2*Math.PI),r=2048/(2*Math.PI),K=2*Math.PI/2048,F=Math.sqrt(9.0/7.0);
 public final Vector3d camera=new Vector3d(),origin=new Vector3d();
 public final Matrix3d inverseFrame=new Matrix3d(),correction=new Matrix3d();
 public double nearScale=1,transitionScale=1;
 public static Vector3d bend(double x,double y,double z,Vector3d out){double t=z*K*.5,s=Math.sin(t),c=Math.cos(t),den=c*c+F*F*s*s,cp=(c*c-F*F*s*s)/den,sp=2*F*s*c/den;double rho=Math.min(R-1,r+(y-16)*(R+r*cp)/R),theta=x/R;return out.set((R+rho*cp)*Math.cos(theta),rho*sp,(R+rho*cp)*Math.sin(theta));}
 public void update(double x,double y,double z){camera.set(x,y,z);bend(x,y,z,origin);double theta=x/R,t=z*K*.5,s=Math.sin(t),c=Math.cos(t),den=c*c+F*F*s*s,cp=(c*c-F*F*s*s)/den,sp=2*F*s*c/den,ct=Math.cos(theta),st=Math.sin(theta);
  Matrix3d frame=new Matrix3d().setColumn(0,new Vector3d(-st,0,ct)).setColumn(1,new Vector3d(cp*ct,sp,cp*st)).setColumn(2,new Vector3d(-sp*ct,cp,-sp*st));inverseFrame.set(frame).transpose();
  Matrix3d jac=new Matrix3d().setColumn(0,bend(x+.01,y,z,new Vector3d()).sub(origin).div(.01)).setColumn(1,bend(x,y+.01,z,new Vector3d()).sub(origin).div(.01)).setColumn(2,bend(x,y,z+.01,new Vector3d()).sub(origin).div(.01));
  correction.set(frame).mul(jac.invert());nearScale=Math.max(1,bound(correction,false));transitionScale=nearScale+bound(correction,true)*256*1.5/160;
 }
 private static double bound(Matrix3d m,boolean minus){double row=0,col=0;for(int i=0;i<3;i++){double a=0,b=0;for(int j=0;j<3;j++){a+=Math.abs(m.get(j,i)-(minus&&i==j?1:0));b+=Math.abs(m.get(i,j)-(minus&&i==j?1:0));}row=Math.max(row,a);col=Math.max(col,b);}return Math.sqrt(row*col);}
 public Vector3d relative(double x,double y,double z,Vector3d out){bend(x,y,z,out).sub(origin);double t=Math.max(0,Math.min(1,(out.length()-96)/160)),weight=1-t*t*(3-2*t);if(weight>0){Vector3d changed=correction.transform(new Vector3d(out)).sub(out);out.fma(weight,changed);}return inverseFrame.transform(out);}
 public double sphere(double minX,double minY,double minZ,double maxX,double maxY,double maxZ,Vector3d center){double h=Math.max(Math.abs(minY-16),Math.abs(maxY-16)),rho=Math.min(R-1,r+h*(1+r/R));double scale=Math.max(1,Math.max((R+rho)/R,rho/r*1.15+h*.0005));double radius=Math.sqrt(Math.pow(maxX-minX,2)+Math.pow(maxY-minY,2)+Math.pow(maxZ-minZ,2))*.5*scale+.001;
  bend((minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2,center);double distance=center.distance(origin);relative((minX+maxX)/2,(minY+maxY)/2,(minZ+maxZ)/2,center);return radius*(distance-radius>=256?1:distance+radius<=96?nearScale:transitionScale);
 }
}

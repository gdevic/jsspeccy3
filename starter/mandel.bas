# MANDEL: the Mandelbrot set in the 32 by 22 colour cells of the screen,
# its top and bottom halves drawn together since they mirror each other.
# Points in the main cardioid and the disc beside it are known to be in
# the set without iterating, which saves most of the time.
10 REM MANDEL
20 BORDER 0: PAPER 0: INK 7: CLS
30 PRINT AT 8,6;"THE MANDELBROT SET"
40 PRINT AT 11,2;"Each square is a point on the"'"  complex plane, coloured by how"'"  fast it flies away. The black"'"  ones never do."
50 PRINT AT 18,6;"Press any key to draw"
60 PAUSE 0: CLS
100 FOR r=0 TO 10: LET y=(10.5-r)*.1
110 FOR c=0 TO 31: LET x=c*.09375-2.2
120 LET q=(x-.25)*(x-.25)+y*y
130 IF q*(q+x-.25)<y*y/4 OR (x+1)*(x+1)+y*y<.0625 THEN LET n=0: GO TO 170
140 LET a=x: LET b=y
150 FOR n=1 TO 15: LET t=a*a: LET u=b*b: IF t+u>4 THEN GO TO 170
160 LET b=2*a*b+y: LET a=t-u+x: NEXT n: LET n=0
170 LET k=n-7*INT ((n-1)/7): IF NOT n THEN LET k=0
180 PRINT AT r,c; PAPER k;" ";AT 21-r,c;" "
190 NEXT c: NEXT r
200 PRINT #1;AT 0,0;"Press any key to see it again";
210 PAUSE 0: RUN

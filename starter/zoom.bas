# ZOOM: the Mandelbrot set drawn by machine code, fast enough to zoom
# into. The arrow keys (or Q, A, O and P) move the flashing square, Z
# zooms in on it, X zooms out and R starts again. The machine code
# (starter/zoom.asm) follows this program on the tape as a CODE block for
# 61440; it keeps a table of squares from 28672, below it, so the program
# starts by moving RAMTOP down under both. USR 61448 makes the table, and
# USR 61451 draws, from the view at 61440 to 61446: the left-hand real
# part, the top imaginary part, the step from one square to the next (each
# a 16-bit number with 12 fraction bits, so 4096 is 1) and the steps a
# point may take before it counts as inside the set.
10 REM ZOOM
20 CLEAR 28671: BORDER 0: PAPER 0: INK 7: CLS
30 PRINT AT 8,7;"THE MANDELBROT SET";AT 9,9;"IN MACHINE CODE"
40 PRINT AT 13,2;"Loading the machine code..."
50 LOAD ""CODE
60 PRINT AT 13,2;"Working out a table of squares";: LET z=USR 61448
70 LET cx=-.6: LET cy=0: LET d=3/32: LET lv=0: LET r=11: LET c=16
100 REM the picture around cx,cy, d apart from one square to the next
110 POKE 61446,24+8*lv
120 LET v=cx-15.5*d: LET p=61440: GO SUB 800
130 LET v=cy+10.5*d: LET p=61442: GO SUB 800
140 LET v=d: LET p=61444: GO SUB 800
150 CLS: PRINT #1;AT 0,0;"Drawing...   SPACE stops it.";
160 LET t=PEEK 23672+256*PEEK 23673: LET z=USR 61451: LET t=PEEK 23672+256*PEEK 23673-t: IF t<0 THEN LET t=t+65536
170 PRINT #1;AT 0,0;"x";2^lv;" in ";INT (t/5+.5)/10;" s";TAB 16;"Z in X out R";TAB 31;" "'"Arrows or QAOP move the square";
200 REM the flashing square
210 LET a=22528+32*r+c: POKE a,PEEK a+128
220 LET k$=INKEY$: IF k$="" THEN GO TO 220
230 POKE a,PEEK a-128
240 LET r=r-(k$="q" OR k$="7" OR k$=CHR$ 11)+(k$="a" OR k$="6" OR k$=CHR$ 10)
250 LET c=c-(k$="o" OR k$="5" OR k$=CHR$ 8)+(k$="p" OR k$="8" OR k$=CHR$ 9)
260 LET r=r+(r<0)-(r>21): LET c=c+(c<0)-(c>31)
270 IF k$="z" AND lv<6 THEN LET cx=cx+(c-15.5)*d: LET cy=cy-(r-10.5)*d: LET d=d/2: LET lv=lv+1: LET r=11: LET c=16: GO TO 100
280 IF k$="z" THEN PRINT #1;AT 1,0;"x64 is as deep as it goes.    ";
290 IF k$="x" AND lv>0 THEN LET d=d*2: LET lv=lv-1: GO TO 100
300 IF k$="r" THEN GO TO 70
310 GO TO 210
800 REM v at p and p+1, as a 16-bit number with 12 fraction bits
810 LET v=INT (v*4096+.5): IF v<0 THEN LET v=v+65536
820 POKE p,v-256*INT (v/256): POKE p+1,INT (v/256): RETURN

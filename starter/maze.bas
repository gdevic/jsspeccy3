# MAZE: a new maze every time, carved on the screen by a random walk
# that backs up when it is boxed in (a depth-first search), so there is
# exactly one way through. Each cell remembers the way the walk came in,
# and following that back from the exit gives the solution. COPY prints
# the maze on the ZX Printer, to solve with a pencil.
10 REM MAZE
20 BORDER 1: PAPER 7: INK 1: CLS: RANDOMIZE
30 LET w$="": FOR i=1 TO 31: LET w$=w$+"\x8f": NEXT i
40 DIM o(4): DIM s(150)
100 REM a new maze: all walls, then the walk carves the cells 2 apart
110 CLS: FOR r=0 TO 20: PRINT AT r,0;w$: NEXT r
120 PRINT #1;AT 0,0;"Carving a maze...";
130 DIM v(15,10): LET x=1: LET y=1: LET v(1,1)=5: LET p=1: LET s(1)=17
140 PRINT AT 1,1;" "
150 LET n=0: IF x>1 THEN IF NOT v(x-1,y) THEN LET n=1: LET o(1)=1
160 IF x<15 THEN IF NOT v(x+1,y) THEN LET n=n+1: LET o(n)=2
170 IF y>1 THEN IF NOT v(x,y-1) THEN LET n=n+1: LET o(n)=3
180 IF y<10 THEN IF NOT v(x,y+1) THEN LET n=n+1: LET o(n)=4
190 IF n THEN GO TO 220
200 LET p=p-1: IF NOT p THEN GO TO 300
210 LET x=INT (s(p)/16): LET y=s(p)-16*x: GO TO 150
220 LET d=o(1+INT (RND*n)): LET a=(d=2)-(d=1): LET b=(d=4)-(d=3)
230 PRINT AT 2*y-1+b,2*x-1+a;" ";AT 2*y-1+2*b,2*x-1+2*a;" "
240 LET x=x+a: LET y=y+b: LET v(x,y)=d: LET p=p+1: LET s(p)=16*x+y: GO TO 150
300 REM the way in and the way out
310 PRINT AT 1,0;" ";AT 19,30;" "
320 PRINT #1;AT 0,0;"S solution  C copy to printer   "'"N new maze";
330 PAUSE 0: LET k$=INKEY$
340 IF k$="s" OR k$="S" THEN GO SUB 400
350 IF k$="c" OR k$="C" THEN COPY
360 IF k$="n" OR k$="N" THEN GO TO 100
370 GO TO 330
400 REM the solution: from the exit back along the way the walk came
410 LET x=15: LET y=10: PRINT AT 19,30; INK 2;"."
420 PRINT AT 2*y-1,2*x-1; INK 2;".": IF v(x,y)=5 THEN PRINT AT 1,0; INK 2;".": RETURN
430 LET d=v(x,y): LET a=(d=2)-(d=1): LET b=(d=4)-(d=3)
440 PRINT AT 2*y-1-b,2*x-1-a; INK 2;".": LET x=x-a: LET y=y-b: GO TO 420

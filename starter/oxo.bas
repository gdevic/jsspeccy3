# OXO: noughts and crosses against the Spectrum. You are X; choose a
# square with keys 1 to 9. The Spectrum wins when it can, stops you
# winning when it must, and otherwise likes the middle, then a corner.
# Who goes first takes turns.
10 REM OXO
20 BORDER 1: PAPER 1: INK 7: CLS: RANDOMIZE
30 DIM l(8,3): RESTORE 900: FOR i=1 TO 8: FOR j=1 TO 3: READ l(i,j): NEXT j: NEXT i
40 LET yw=0: LET sw=0: LET dr=0: LET fs=1
100 REM a new game
110 CLS: DIM b(9): LET mv=0
120 PLOT 64,159: DRAW 0,-144: PLOT 120,159: DRAW 0,-144: PLOT 8,111: DRAW 168,0: PLOT 8,63: DRAW 168,0
130 FOR i=1 TO 9: PRINT AT 2+6*INT ((i-1)/3),1+7*(i-1-3*INT ((i-1)/3)); INK 5;i: NEXT i
140 PRINT AT 0,23; INK 6;"OXO";AT 3,23;"You   ";yw;AT 4,23;"Me    ";sw;AT 5,23;"Draws ";dr
150 IF fs=2 THEN GO TO 300
200 REM your move
210 PRINT AT 9,23;"Your go:";AT 10,23;"1 to 9  "
220 PAUSE 0: LET k$=CHR$ PEEK 23560: IF k$<"1" OR k$>"9" THEN GO TO 220
230 LET m=VAL k$: IF b(m) THEN GO TO 220
240 LET p=1: GO SUB 600: IF g THEN GO TO 400
300 REM the Spectrum's move
310 PRINT AT 9,23;"My go...";AT 10,23;"        ": PAUSE 25
320 LET p=2: GO SUB 700: IF m THEN GO TO 380
330 LET p=1: GO SUB 700: IF m THEN GO TO 380
340 IF NOT b(5) THEN LET m=5: GO TO 380
350 LET m=2*INT (RND*4)+1: IF m=5 THEN LET m=9
355 IF NOT b(m) THEN GO TO 380
360 FOR i=1 TO 9: LET m=1+INT (RND*9): IF NOT b(m) THEN GO TO 380
370 NEXT i: FOR m=1 TO 9: IF b(m) THEN NEXT m
380 LET p=2: GO SUB 600: IF g THEN GO TO 400
390 GO TO 200
400 REM the game is over: g is 1 for you, 2 for the Spectrum, 3 a draw
410 IF g=1 THEN LET yw=yw+1: PRINT AT 9,23; INK 4;"You win!": FOR i=0 TO 12 STEP 3: BEEP .08,i: NEXT i
420 IF g=2 THEN LET sw=sw+1: PRINT AT 9,23; INK 2;"I win!  ": BEEP .3,-10
430 IF g=3 THEN LET dr=dr+1: PRINT AT 9,23; INK 6;"A draw. ": BEEP .2,0
440 PRINT AT 3,23;"You   ";yw;AT 4,23;"Me    ";sw;AT 5,23;"Draws ";dr;AT 10,23;"        ";AT 12,23;"Any key:";AT 13,23;"again"
450 LET fs=3-fs: PAUSE 50: PAUSE 0: GO TO 100
600 REM player p takes square m; g says if the game is over
610 LET b(m)=p: LET mv=mv+1: LET x=36+56*(m-1-3*INT ((m-1)/3)): LET y=135-48*INT ((m-1)/3)
620 IF p=1 THEN INK 4: PLOT x-14,y-14: DRAW 28,28: PLOT x-14,y+14: DRAW 28,-28: INK 7: BEEP .02,20
630 IF p=2 THEN INK 6: CIRCLE x,y,15: INK 7: BEEP .02,10
640 LET g=0: FOR i=1 TO 8: IF b(l(i,1))=p AND b(l(i,2))=p AND b(l(i,3))=p THEN LET g=p
650 NEXT i: IF NOT g AND mv=9 THEN LET g=3
660 RETURN
700 REM m, the square that completes a line of player p, or 0
710 LET m=0: FOR i=1 TO 8: LET n=(b(l(i,1))=p)+(b(l(i,2))=p)+(b(l(i,3))=p)
720 IF n=2 THEN FOR j=1 TO 3: IF NOT b(l(i,j)) THEN LET m=l(i,j): RETURN
730 IF n=2 THEN NEXT j
740 NEXT i: RETURN
900 DATA 1,2,3,4,5,6,7,8,9,1,4,7,2,5,8,3,6,9,1,5,9,3,5,7

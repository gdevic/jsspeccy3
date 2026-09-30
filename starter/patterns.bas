# PATTERNS: line drawings from a little mathematics, a different one
# each time: a times table round a circle, a rose, a spirograph and a
# Lissajous figure. Any key draws the next; C copies the screen to the
# ZX Printer first.
10 REM PATTERNS
20 BORDER 0: PAPER 0: INK 7: BRIGHT 1: CLS: RANDOMIZE
30 LET p=0
100 LET p=p+1-4*(p=4): CLS: INK 3+INT (RND*5)
110 GO SUB 100*p+100
120 INK 7: PRINT #1;AT 0,0;"Any key: the next pattern"'"C: copy it to the printer";
130 PAUSE 0: LET k$=INKEY$: IF k$="c" OR k$="C" THEN COPY: GO TO 130
140 GO TO 100
200 REM a times table round a circle: point i joined to point i*m
210 LET m=2+INT (RND*8): LET n=100: DIM x(n): DIM y(n)
220 PRINT AT 0,0;"Times table ";m;" round a circle"
230 FOR i=1 TO n: LET a=2*PI*(i-1)/n: LET x(i)=128+78*SIN a: LET y(i)=84+78*COS a: NEXT i
240 FOR i=0 TO n-1: LET j=i*m-n*INT (i*m/n): PLOT x(i+1),y(i+1): DRAW x(j+1)-x(i+1),y(j+1)-y(i+1): NEXT i
250 RETURN
300 REM a rose: r = cos (k t)
310 LET k=2+INT (RND*6): LET d=1+(k/2=INT (k/2))
320 PRINT AT 0,0;"A rose with ";k*d;" petals"
330 PLOT 206,84: FOR t=0 TO d*PI+.01 STEP d*PI/150: LET r=78*COS (k*t)
340 DRAW 128+r*COS t-PEEK 23677,84+r*SIN t-PEEK 23678: NEXT t
350 RETURN
400 REM a spirograph: a wheel of radius b rolling inside a ring of radius a
410 LET a=5+INT (RND*4): LET b=1+INT (RND*(a-2)): LET h=b*(.6+RND*.8): LET s=75/(a-b+h)
420 PRINT AT 0,0;"Spirograph ";a;":";b
430 LET g=b: LET f=a
435 LET e=f-g*INT (f/g): IF e THEN LET f=g: LET g=e: GO TO 435
440 LET e=2*PI*b/g
450 PLOT 128+s*(a-b+h),88: FOR t=0 TO e+.01 STEP e/200
460 DRAW 128+s*((a-b)*COS t+h*COS ((a-b)*t/b))-PEEK 23677,88+s*((a-b)*SIN t-h*SIN ((a-b)*t/b))-PEEK 23678: NEXT t
470 RETURN
500 REM a Lissajous figure
510 LET a=1+INT (RND*5): LET b=a+1+INT (RND*3): LET f=RND*PI
520 PRINT AT 0,0;"Lissajous ";a;":";b
530 PLOT 128+100*SIN f,84: FOR t=0 TO 2*PI+.01 STEP PI/150
540 DRAW 128+100*SIN (a*t+f)-PEEK 23677,84+76*SIN (b*t)-PEEK 23678: NEXT t
550 RETURN

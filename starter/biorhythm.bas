# BIORHYTHM: the 23, 28 and 33 day cycles of body, feelings and mind,
# drawn for a month from any date.
10 REM BIORHYTHM
20 BORDER 1: PAPER 7: INK 0: CLS
30 PRINT AT 1,10; PAPER 1; INK 7; BRIGHT 1;" BIORHYTHM "
40 PRINT AT 4,0;"Ever since the day you were born"'"your body, feelings and mind run"'"in cycles of 23, 28 and 33 days."
50 PRINT AT 8,0;"Up is a strong day, down a weak"'"one, and where a curve crosses"'"the middle line, take care!"
60 PRINT AT 12,0;"Type each date as day, month and"'"year, for example 25, 12, 1985."
70 INPUT "Your birthday: day ";bd;", month ";bm;", year ";by
80 LET d=bd: LET m=bm: LET y=by: GO SUB 1000: IF NOT ok THEN PRINT AT 16,0; INK 2;"There is no such day. Try again.": GO TO 70
90 LET jb=j
100 INPUT "Chart from: day ";d;", month ";m;", year ";y
110 GO SUB 1000: IF NOT ok THEN PRINT AT 16,0; INK 2;"There is no such day. Try again.": GO TO 100
120 IF j<jb THEN PRINT AT 16,0; INK 2;"That is before you were born!  ": GO TO 100
130 LET j0=j
200 CLS: LET t=j0-jb
210 PRINT AT 0,0; INK 2;"PHYSICAL 23"; INK 4;" EMOTIONAL 28"; INK 1;" MIND 33"
220 PLOT 16,88: DRAW 210,0: PLOT 16,32: DRAW 0,112
230 FOR k=0 TO 30: PLOT 16+7*k,86: DRAW 0,4: NEXT k
240 FOR k=0 TO 30 STEP 5: LET j=j0+k: GO SUB 1100: PRINT AT 19,INT ((16+7*k)/8);dd: NEXT k
250 LET j=j0: GO SUB 1100: PRINT AT 20,0;"From ";dd;"/";mo;"/";yr;" (day ";t;")"
260 FOR c=1 TO 3: LET p=18+5*c: INK 2*(c=1)+4*(c=2)+(c=3)
270 PLOT 16,88+56*SIN (2*PI*t/p)
280 FOR k=.5 TO 30 STEP .5: DRAW 16+7*k-PEEK 23677,88+56*SIN (2*PI*(t+k)/p)-PEEK 23678: NEXT k
290 NEXT c: INK 0
300 PRINT AT 21,0;"That day:";
310 FOR c=1 TO 3: LET p=18+5*c: LET v=INT (100*SIN (2*PI*t/p)+.5)
320 PRINT INK 2*(c=1)+4*(c=2)+(c=3);TAB (c*8+3);v;"%";: NEXT c
400 PRINT #1;AT 0,0;"N next month   P previous month"'"C copy to printer  B birthday";
410 PAUSE 0: LET k$=INKEY$
420 IF k$="n" OR k$="N" THEN LET j0=j0+30: GO TO 200
430 IF (k$="p" OR k$="P") AND j0-30>=jb THEN LET j0=j0-30: GO TO 200
440 IF k$="c" OR k$="C" THEN COPY: GO TO 410
450 IF k$="b" OR k$="B" THEN GO TO 20
460 GO TO 410
1000 REM day number j of d/m/y; ok is 0 for a date that isn't one
1010 LET ok=(d=INT d) AND (m=INT m) AND (y=INT y) AND (m>=1) AND (m<=12) AND (y>=1800) AND (y<=2200) AND (d>=1)
1020 IF NOT ok THEN RETURN
1030 LET a=INT ((14-m)/12): LET yy=y+4800-a: LET mm=m+12*a-3
1040 LET j=d+INT ((153*mm+2)/5)+365*yy+INT (yy/4)-INT (yy/100)+INT (yy/400)-32045
1060 GO SUB 1100: LET ok=(dd=d) AND (mo=m)
1070 RETURN
1100 REM the date dd/mo/yr of day number j
1110 LET a=j+32044: LET b=INT ((4*a+3)/146097): LET a=a-INT (146097*b/4)
1120 LET e=INT ((4*a+3)/1461): LET a=a-INT (1461*e/4): LET f=INT ((5*a+2)/153)
1130 LET dd=a-INT ((153*f+2)/5)+1: LET mo=f+3-12*INT (f/10): LET yr=100*b+e-4800+INT (f/10)
1140 RETURN

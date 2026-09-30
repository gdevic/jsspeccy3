# CALENDAR: any month from 1753 on, on the screen and on the ZX Printer,
# or a whole year on the printer. The same routine prints to either, as
# stream 2 is the screen and stream 3 the printer.
10 REM CALENDAR
20 BORDER 5: PAPER 7: INK 0: CLS
30 DIM m$(12,9): DIM d(12): RESTORE 900
40 FOR i=1 TO 12: READ m$(i),d(i): NEXT i
50 PRINT AT 1,11; PAPER 5;" CALENDAR "
60 PRINT AT 4,0;"Any month from 1753 on, on the"'"screen and on the ZX Printer."
70 INPUT "Year? ";y: IF y<1753 OR y>9999 OR y<>INT y THEN GO TO 70
80 INPUT "Month 1 to 12 (0 = whole year)? ";m: IF m<0 OR m>12 OR m<>INT m THEN GO TO 80
90 IF m=0 THEN GO TO 500
100 CLS: PRINT AT 2,0;: LET s=2: GO SUB 300
110 PRINT #1;AT 0,0;"P print    N next    B back"'"Y whole year    D another date";
120 PAUSE 0: LET k$=INKEY$
130 IF k$="p" OR k$="P" THEN LET s=3: GO SUB 300: LPRINT: GO TO 120
140 IF k$="n" OR k$="N" THEN LET m=m+1: IF m>12 THEN LET m=1: LET y=y+1
150 IF k$="b" OR k$="B" THEN LET m=m-1: IF m<1 THEN LET m=12: LET y=y-1
160 IF (k$="n" OR k$="N" OR k$="b" OR k$="B") AND y>=1753 THEN GO TO 100
170 IF k$="y" OR k$="Y" THEN GO TO 500
180 IF k$="d" OR k$="D" THEN GO TO 20
190 GO TO 120
300 REM month m of year y, printed on stream s
310 LET t$=m$(m)
320 IF t$(LEN t$)=" " THEN LET t$=t$(1 TO LEN t$-1): GO TO 320
330 LET t$=t$+" "+STR$ y
340 PRINT #s;TAB 6+INT ((20-LEN t$)/2);t$
350 PRINT #s;TAB 6;"Mo Tu We Th Fr Sa Su"
360 LET d=1: GO SUB 800: LET w=j-7*INT (j/7)
370 LET n=d(m)+((m=2) AND (((y/4=INT (y/4)) AND (y/100<>INT (y/100))) OR (y/400=INT (y/400))))
380 LET l$="      ": FOR i=1 TO w: LET l$=l$+"   ": NEXT i
390 FOR d=1 TO n: LET l$=l$+(" " AND d<10)+STR$ d+" ": LET w=w+1
400 IF w=7 THEN PRINT #s;l$: LET l$="      ": LET w=0
410 NEXT d: IF w THEN PRINT #s;l$
420 RETURN
500 REM the whole year on the printer
510 CLS: PRINT AT 2,0;"Printing ";y;" on the ZX Printer"
520 LPRINT: LPRINT TAB 14;y: LPRINT
530 FOR m=1 TO 12: PRINT AT 4,0;m$(m): LET s=3: GO SUB 300: LPRINT: NEXT m
540 LPRINT "- - - - - - - - - - - - - - - - "
550 PRINT AT 4,0;"Done.     "'"Press any key."
560 PAUSE 0: GO TO 20
800 REM day number j of d/m/y; j-7*INT (j/7) is the weekday, 0 Monday
810 LET a=INT ((14-m)/12): LET yy=y+4800-a: LET mm=m+12*a-3
820 LET j=d+INT ((153*mm+2)/5)+365*yy+INT (yy/4)-INT (yy/100)+INT (yy/400)-32045
830 RETURN
900 DATA "January",31,"February",28,"March",31,"April",30
910 DATA "May",31,"June",30,"July",31,"August",31
920 DATA "September",30,"October",31,"November",30,"December",31

# SIMON: watch the pads light up, then play the same order back with
# keys 1 to 4 (or Q, W, A, S). One more each round, and faster as you go.
# A key is read with INKEY$, or from LAST_K (23560), where the ROM keeps
# the last key pressed, so a quick tap while a pad is still being drawn
# still counts.
10 REM SIMON
20 BORDER 0: PAPER 0: INK 7: CLS: RANDOMIZE
30 DIM c(4): DIM t(4): DIM y(4): DIM x(4): RESTORE 900: FOR i=1 TO 4: READ c(i),t(i),y(i),x(i): NEXT i
40 DIM p$(13): LET hi=0: DIM s(99)
100 REM a new game
110 CLS: LET b=0: FOR i=1 TO 4: LET k=i: GO SUB 500: NEXT i
120 PRINT AT 10,13;"SIMON";AT 11,11;"best ";hi
130 PRINT #1;AT 0,0;"Keys 1 2 3 4, or Q W A S."'"Press a key to start.";
140 PAUSE 0: PRINT #1;AT 0,0;"                                "'"                                ";
150 FOR i=1 TO 99: LET s(i)=1+INT (RND*4): NEXT i: LET r=0: LET d=.4
200 REM the next round: Simon plays the order so far, one longer
210 LET r=r+1: IF r>99 THEN LET r=99
220 PRINT AT 10,13; INK 6;"ROUND";AT 11,11;"        ";AT 11,14;r: PAUSE 30
230 IF r=6 OR r=10 OR r=14 THEN LET d=d*.75
240 FOR i=1 TO r: LET k=s(i): GO SUB 600: PAUSE 5: NEXT i
300 REM your turn
305 POKE 23560,0
310 FOR i=1 TO r: LET w=0
320 PAUSE 250: LET k$=INKEY$: IF k$="" THEN LET k$=CHR$ PEEK 23560
325 POKE 23560,0: IF k$=CHR$ 0 THEN LET w=w+1: IF w<2 THEN GO TO 320
330 LET k=(k$="1" OR k$="q" OR k$="Q")+2*(k$="2" OR k$="w" OR k$="W")+3*(k$="3" OR k$="a" OR k$="A")+4*(k$="4" OR k$="s" OR k$="S")
340 IF k$=CHR$ 0 THEN GO TO 400
350 IF NOT k THEN GO TO 320
370 IF k<>s(i) THEN GO TO 400
380 GO SUB 600: NEXT i
390 PAUSE 25: GO TO 200
400 REM a wrong pad, or too slow
410 LET b=1: LET k=s(i): GO SUB 500: BEEP 1,-24: LET b=0: GO SUB 500
420 IF r-1>hi THEN LET hi=r-1
430 PRINT AT 10,13; INK 2;"OOPS!";AT 11,11;"score ";r-1;"  "
440 PAUSE 100: GO TO 100
500 REM pad k drawn, lit when b is 1
520 PRINT PAPER c(k); BRIGHT b;AT y(k),x(k);p$;AT y(k)+1,x(k);p$;AT y(k)+2,x(k);p$;AT y(k)+3,x(k);p$;AT y(k)+4,x(k);p$;AT y(k)+5,x(k);p$;AT y(k)+6,x(k);p$;AT y(k)+7,x(k);p$
530 PRINT PAPER c(k); BRIGHT b; INK 0;AT y(k)+3,x(k)+6;k: RETURN
600 REM pad k lights up and sounds
610 LET kk=k: LET b=1: GO SUB 500: BEEP d,t(kk): LET k=kk: LET b=0: GO SUB 500: RETURN
900 REM each pad: colour, note, row and column
910 DATA 4,16,1,1,2,13,1,18,6,9,13,1,5,4,13,18

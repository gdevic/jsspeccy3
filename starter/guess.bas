# GUESS: think of something, and the Spectrum finds out what by asking
# yes or no questions, down a tree it loads from the DATA cartridge in
# Microdrive 2. When it guesses wrong it asks what it was and for a
# question that tells the two apart, and keeps them on the cartridge.
# The tree is a character array t$(): row 1 is "T", the number of rows
# in use (3 digits) and the theme; a question is "Q", the rows of its yes
# and no answers (3 digits each) and the question; a thing is "A" and its
# name, as the guess asks for it ("a kettle"). A key is read with INKEY$,
# or from LAST_K (23560), where the ROM keeps the last key pressed, when
# it was let go before INKEY$ could see it.
10 REM GUESS
20 BORDER 0: PAPER 0: INK 7: CLS: DIM b$(64)
30 PRINT AT 1,7; INK 6;"THE GUESSING GAME"
40 PRINT AT 4,0;"Think of something, and I will"'"find out what it is by asking"'"questions. If I get it wrong,"'"teach me, and I will know it"'"next time."
50 PRINT AT 11,4;"1  a thing in your home";AT 13,4;"2  an animal"
60 PRINT AT 17,0; INK 5;"What I learn is kept on the DATA"'"cartridge in Microdrive 2."
70 PAUSE 0: LET k$=CHR$ PEEK 23560: IF k$<>"1" AND k$<>"2" THEN GO TO 70
80 LET f$="things": IF k$="2" THEN LET f$="animals"
90 CLS: PRINT AT 10,2;"Reading Microdrive 2..."
100 LOAD *"m";2;f$ DATA t$()
110 LET n=VAL t$(1,2 TO 4): LET s$=t$(1,5 TO ): GO SUB 900: LET h$=s$
200 REM a new round
210 CLS: INK 6: LET s$="Think of "+h$+".": LET r=1: GO SUB 950: INK 7: PRINT AT 3,0;"Press a key when you have one."
220 PAUSE 0: LET p=2: LET q=0
230 IF t$(p,1)="A" THEN GO TO 300
240 LET q=q+1: LET s$=t$(p,8 TO ): GO SUB 900
250 PRINT AT 6,0;"Question ";q;AT 8,0;b$: INK 5: LET r=8: GO SUB 950: INK 7
260 GO SUB 800: IF y THEN LET p=VAL t$(p,2 TO 4): GO TO 230
270 LET p=VAL t$(p,5 TO 7): GO TO 230
300 REM the guess
310 LET s$=t$(p,2 TO ): GO SUB 900: LET a$=s$
320 PRINT AT 6,0;b$;AT 8,0;b$: INK 5: LET s$="Is it "+a$+"?": LET r=8: GO SUB 950: INK 7
330 GO SUB 800: IF NOT y THEN GO TO 400
340 PRINT AT 12,0; INK 4;"I guessed it with ";q;" questions!": FOR i=0 TO 12 STEP 4: BEEP .08,i: NEXT i
350 GO TO 600
400 REM something new to learn
410 IF n+2>360 THEN PRINT AT 12,0; INK 2;"You win! My memory is full.": GO TO 600
420 CLS: PRINT AT 1,0; INK 5;"You win! What were you thinking"'"of? Start with a or an."
430 INPUT LINE c$: IF c$="" OR LEN c$>47 THEN GO TO 430
440 PRINT AT 4,0; INK 6;c$
450 INK 5: LET s$="Type a question that tells "+c$+" from "+a$+".": LET r=7: GO SUB 950: INK 7
460 INPUT LINE d$: IF d$="" OR LEN d$>40 THEN GO TO 460
470 IF d$(LEN d$)<>"?" THEN LET d$=d$+"?"
480 INK 6: LET s$=d$: LET r=13: GO SUB 950: INK 5: LET s$="For "+c$+", is the answer yes?": LET r=16: GO SUB 950: INK 7
490 GO SUB 800
500 LET e$=STR$ (1001+n): LET g$=STR$ (1002+n)
510 LET t$(n+1)=t$(p): LET t$(n+2)="A"+c$
520 IF y THEN LET t$(p)="Q"+g$(2 TO 4)+e$(2 TO 4)+d$
530 IF NOT y THEN LET t$(p)="Q"+e$(2 TO 4)+g$(2 TO 4)+d$
540 LET n=n+2: LET e$=STR$ (1000+n): LET t$(1,2 TO 4)=e$(2 TO 4)
550 CLS: LET s$="Thank you! Now I know "+c$+".": LET r=6: GO SUB 950
560 PRINT AT 11,0;"Shall I keep that on the"'"cartridge?"
570 GO SUB 800: IF NOT y THEN GO TO 600
580 PRINT AT 15,0;"Saving to Microdrive 2..."
590 ERASE "m";2;f$: SAVE *"m";2;f$ DATA t$(): PRINT AT 15,0;"Saved.                   "
600 REM another go
610 PRINT #1;AT 0,0;"Y another go   N stop"'"C change the game";
620 PAUSE 0: GO SUB 850
630 IF k$="y" OR k$="Y" THEN GO TO 200
640 IF k$="c" OR k$="C" THEN GO TO 20
650 IF k$="n" OR k$="N" THEN CLS: PRINT "Goodbye!": STOP
660 GO TO 620
800 REM y is 1 for yes, 0 for no
810 PRINT #1;AT 0,0;"Y yes    N no";
820 PAUSE 0: GO SUB 850: IF k$<>"y" AND k$<>"Y" AND k$<>"n" AND k$<>"N" THEN GO TO 820
830 LET y=(k$="y" OR k$="Y"): PRINT #1;AT 0,0;"             ";: RETURN
850 REM k$, the key just pressed, taken from LAST_K if it is up already;
855 REM in keyword mode Y gives RETURN there, N NEXT and C CONTINUE
857 LET k$=INKEY$: IF k$="" THEN LET k$=CHR$ PEEK 23560
860 IF k$=CHR$ 254 THEN LET k$="y"
870 IF k$=CHR$ 243 THEN LET k$="n"
880 IF k$=CHR$ 232 THEN LET k$="c"
890 RETURN
900 REM s$ without its trailing spaces
910 IF s$="" THEN RETURN
920 IF s$(LEN s$)=" " THEN LET s$=s$(1 TO LEN s$-1): GO TO 910
930 RETURN
950 REM s$ printed from row r, broken between words
960 IF LEN s$<=32 THEN PRINT AT r,0;s$: RETURN
970 FOR i=33 TO 2 STEP -1: IF s$(i)=" " THEN PRINT AT r,0;s$(1 TO i-1): LET s$=s$(i+1 TO ): LET r=r+1: GO TO 960
980 NEXT i: PRINT AT r,0;s$(1 TO 32): LET s$=s$(33 TO ): LET r=r+1: GO TO 960

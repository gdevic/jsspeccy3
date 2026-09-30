# TUNE: tunes played with BEEP on a two-octave keyboard drawn on the
# screen, each key lighting up as it sounds, or the keyboard played from
# the Spectrum's own keys. A note is its distance in semitones from
# middle C, as BEEP takes it; w() gives each note of the octave its white
# key (a black key sits after the white key of the note below it).
10 REM TUNE
20 BORDER 1: PAPER 1: INK 7: BRIGHT 0: CLS
30 FOR i=0 TO 7: POKE USR "a"+i,1: NEXT i
40 LET n$="C C#D D#E F F#G G#A A#B ": LET m$="awsedftgyhujk"
50 DIM w(12): RESTORE 990: FOR i=1 TO 12: READ w(i): NEXT i
60 GO SUB 800
100 REM the menu
110 PRINT AT 0,0; INK 6;"TUNE";AT 2,0;"1 Ode to Joy               ";AT 3,0;"2 Greensleeves             ";AT 4,0;"3 Twinkle, twinkle         ";AT 5,0;"4 Play it yourself         "
120 PRINT AT 7,0;"To put a tune on tape, put the  ";AT 8,0;"blank cassette in the recorder  ";AT 9,0;"and hold its Record key.        "
130 PRINT AT 20,0;"                                "
140 PAUSE 0: LET k$=INKEY$: IF k$<"1" OR k$>"4" THEN GO TO 140
150 IF k$="4" THEN GO TO 600
160 RESTORE 900+10*VAL k$: READ t$,tm
170 PRINT AT 7,0;"Playing ";t$;TAB 31;" ";AT 8,0;"Press a key to stop.";TAB 31;" ";AT 9,0;TAB 31;" "
180 READ p,d: IF p=99 OR INKEY$<>"" THEN GO TO 100
190 GO SUB 700: BEEP d*tm,p: GO SUB 750: GO TO 180
600 REM the keyboard played from the keys
610 PRINT AT 7,0;"Keys A S D F G H J K play the   ";AT 8,0;"white keys, W E T Y U the black.";AT 9,0;"0 goes back to the menu.        "
620 LET k$=INKEY$: IF k$="" THEN GO TO 620
625 IF k$="0" THEN GO TO 100
630 FOR j=1 TO 13: IF m$(j)=k$ THEN LET p=j-1: GO SUB 700: BEEP .1,p: GO SUB 750: GO TO 620
640 NEXT j: GO TO 620
700 REM key p lights up, and its name shows
710 LET o=INT (p/12): LET q=p-12*o: PRINT AT 20,13;"   ";n$(2*q+1 TO 2*q+2);o+4;"   "
720 IF w(q+1)>=0 THEN LET c=2+2*(7*o+w(q+1)): PRINT AT 15,c; PAPER 4;"  ";AT 16,c;"  ";AT 17,c;"  ": RETURN
730 LET c=3+2*(7*o+w(q)): PRINT AT 12,c; PAPER 2;" ";AT 13,c;" ";AT 14,c;" ": RETURN
750 REM key p goes back to its colour
760 IF w(q+1)>=0 THEN PRINT PAPER 7; INK 0;AT 15,c;" \a";AT 16,c;" \a";AT 17,c;" \a": RETURN
770 PRINT PAPER 0;AT 12,c;" ";AT 13,c;" ";AT 14,c;" ": RETURN
800 REM the keyboard: 14 white keys from middle C, then the black ones
810 FOR k=0 TO 13: FOR r=12 TO 17: PRINT AT r,2+2*k; PAPER 7; INK 0;" \a": NEXT r: NEXT k
820 FOR k=0 TO 12: LET q=k-7*INT (k/7): IF q<>2 AND q<>6 THEN FOR r=12 TO 14: PRINT AT r,3+2*k; PAPER 0;" ": NEXT r
830 NEXT k: RETURN
900 REM each tune: its name and the seconds a beat lasts, then note and beats, to 99
910 DATA "Ode to Joy",.35,4,1,4,1,5,1,7,1,7,1,5,1,4,1,2,1,0,1,0,1,2,1,4,1,4,1.5,2,.5,2,2,4,1,4,1,5,1,7,1,7,1,5,1,4,1,2,1,0,1,0,1,2,1,4,1,2,1.5,0,.5,0,2,99,0
920 DATA "Greensleeves",.25,9,1,12,2,14,1,16,1.5,17,.5,16,1,14,2,11,1,7,1.5,9,.5,11,1,12,2,9,1,9,1.5,8,.5,9,1,11,2,8,1,4,2,9,1,12,2,14,1,16,1.5,17,.5,16,1,14,2,11,1,7,1.5,9,.5,11,1,12,1.5,11,.5,9,1,8,1.5,6,.5,8,1,9,3,99,0
930 DATA "Twinkle, twinkle",.3,0,1,0,1,7,1,7,1,9,1,9,1,7,2,5,1,5,1,4,1,4,1,2,1,2,1,0,2,7,1,7,1,5,1,5,1,4,1,4,1,2,2,7,1,7,1,5,1,5,1,4,1,4,1,2,2,0,1,0,1,7,1,7,1,9,1,9,1,7,2,5,1,5,1,4,1,4,1,2,1,2,1,0,2,99,0
990 DATA 0,-1,1,-1,2,3,-1,4,-1,5,-1,6

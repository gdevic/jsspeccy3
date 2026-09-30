# INVADERS: waves of aliens march down; O and P move, SPACE fires.
# The aliens' second pose is a copy of the graphics 168 bytes lower,
# switched in by moving the UDG system variable, so all of them change
# at once. The keys are read from the ports, so moving and firing work
# together.
10 REM INVADERS
20 CLEAR 65199: GO SUB 900
30 LET hi=0
40 BORDER 0: PAPER 0: INK 7: BRIGHT 1: CLS
50 PRINT AT 2,12; INK 6;"INVADERS"
60 PRINT AT 6,9; INK 5;"\a = 30 points"
70 PRINT AT 8,9; INK 3;"\b = 20 points"
80 PRINT AT 10,9; INK 4;"\c = 10 points"
90 PRINT AT 13,8;"O left   P right"
100 PRINT AT 15,11;"SPACE fire"
110 PRINT AT 18,9;"High score ";hi
120 PRINT AT 20,4; FLASH 1;" Press any key to play "
130 PAUSE 0
140 LET sc=0: LET li=3: LET wv=0
150 LET wv=wv+1: DIM a$(4,16): DIM c(4)
160 FOR r=1 TO 4: LET a$(r)=("\a \a \a \a \a \a \a \a " AND r=1)+("\b \b \b \b \b \b \b \b " AND (r=2 OR r=3))+("\c \c \c \c \c \c \c \c " AND r=4): LET c(r)=8: NEXT r
170 LET n=32: LET lr=4: LET ax=1: LET ay=1+wv: IF ay>6 THEN LET ay=6
180 LET dx=1: LET px=15: LET sy=0: LET by=0: LET tk=0: LET f=0: LET nw=0: LET sp=INT (n/5)+1
190 CLS: GO SUB 800: PRINT AT 21,px; INK 4;"\d";: GO SUB 500
200 LET k=IN 57342: LET k=k-32*INT (k/32): IF k<31 THEN LET m=(INT (k/2)*2=k)-(INT (k/4)*2=INT (k/2)): IF m THEN IF px+m>=0 AND px+m<=31 THEN PRINT AT 21,px;" ";: LET px=px+m: PRINT AT 21,px; INK 4;"\d";
220 IF NOT sy THEN LET k=IN 32766: IF INT (k/2)*2=k THEN LET sy=21: LET sx=px: BEEP .003,30
230 IF sy THEN GO SUB 600
250 IF nw THEN GO TO 150
300 IF NOT by THEN IF RND<.15 THEN LET bx=ax+2*INT (RND*8): LET by=ay+2*lr-1
310 IF by THEN PRINT AT by,bx;" ";: LET by=by+1: IF by>21 THEN LET by=0
320 IF by=21 THEN IF bx=px THEN GO TO 700
330 IF by THEN PRINT AT by,bx; INK 6;"\e";
400 LET tk=tk+1: IF tk<sp THEN GO TO 200
410 LET tk=0: LET f=1-f: POKE 23675,88+88*f: POKE 23676,255-f
420 IF ax+dx>=1 AND ax+dx<=15 THEN LET ax=ax+dx: GO SUB 500: GO TO 200
430 FOR r=0 TO 2*lr-2 STEP 2: PRINT AT ay+r,0;"                                ";: NEXT r
440 LET ay=ay+1: LET dx=-dx: GO SUB 500: BEEP .01,-20
450 IF ay+2*lr-2>=20 THEN GO TO 750
460 GO TO 200
500 REM draw the aliens
510 FOR r=1 TO lr: PRINT AT ay+2*r-2,ax-1; INK 7-2*(r=1)-4*(r>1 AND r<4)-3*(r=4);" ";a$(r);" ";: NEXT r
520 RETURN
600 REM the shot goes up two rows, and hits the first alien in its way
605 IF sy<21 THEN PRINT AT sy,sx;" ";
610 FOR s=sy-1 TO sy-2 STEP -1: IF s<1 THEN LET sy=0: RETURN
615 LET r=s-ay: IF r>=0 AND r<=2*lr-2 AND r=2*INT (r/2) AND sx>=ax AND sx<=ax+14 THEN LET r=r/2+1: LET q=sx-ax+1: IF a$(r,q)<>" " THEN GO TO 630
620 NEXT s: LET sy=sy-2: PRINT AT sy,sx; INK 7;"\f";: RETURN
630 LET a$(r,q)=" ": PRINT AT s,sx; INK 2;"\g";: LET sy=0: BEEP .01,-10
640 LET sc=sc+10*INT ((7-r)/2): LET n=n-1: LET c(r)=c(r)-1: LET sp=INT (n/5)+1: GO SUB 800
650 IF n=0 THEN LET sc=sc+100: LET nw=1: RETURN
660 IF c(lr)=0 THEN LET lr=lr-1: GO TO 660
670 RETURN
700 REM the base is hit
710 LET by=0: FOR i=1 TO 8: PRINT AT 21,px; INK 2;"\g";: BEEP .02,-30+i: PRINT AT 21,px; INK 6;"\d";: NEXT i
720 LET li=li-1: GO SUB 800: IF li>0 THEN PRINT AT 21,px;" ";: LET px=15: PRINT AT 21,px; INK 4;"\d";: GO TO 200
750 REM game over
760 IF sc>hi THEN LET hi=sc
770 PRINT AT 11,10; PAPER 2; INK 7; FLASH 1;" GAME OVER ": FOR i=1 TO 3: BEEP .2,-10*i: NEXT i
780 POKE 23675,88: POKE 23676,255: PAUSE 150: GO TO 40
800 REM the score line
810 PRINT AT 0,0; INK 5;"SCORE ";sc;TAB 12;"HI ";hi;TAB 22;"LIVES ";li;" ": RETURN
900 REM graphics: A to G, then a copy of them with the aliens' second pose
910 RESTORE 950: FOR i=0 TO 55: READ b: POKE USR "a"+i,b: NEXT i
920 FOR i=0 TO 167: POKE 65200+i,PEEK (USR "a"+i): NEXT i
930 FOR i=0 TO 23: READ b: POKE 65200+i,b: NEXT i
940 RETURN
950 DATA 24,60,126,219,255,36,90,165
951 DATA 36,24,60,90,255,189,165,36
952 DATA 60,126,255,153,255,36,90,129
953 DATA 0,24,24,126,255,255,255,0
954 DATA 16,8,16,32,16,8,16,0
955 DATA 24,24,24,24,0,0,0,0
956 DATA 146,84,0,198,0,84,146,0
960 DATA 24,60,126,219,255,90,129,66
961 DATA 36,153,189,219,255,60,36,66
962 DATA 60,126,255,153,255,90,129,66

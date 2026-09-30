# TETRIS: O and P move, Q turns, A drops faster, SPACE drops at once.
# Whether a piece fits is read off the screen with ATTR: an empty cell
# of the well is black paper (attribute 71, bright white ink), and the
# walls and the fallen pieces are not. The piece in play keeps its 4
# cells as row and column offsets in y1 to y4 and x1 to x4, so it moves
# with one PRINT to rub it out and one to draw it again. Each row of the
# well is also kept as it is printed, a string of 10 cells each made of
# the PAPER control code, its colour and a space, so a full row goes by
# moving strings down and printing them.
10 REM TETRIS
20 BORDER 0: PAPER 0: INK 7: BRIGHT 1: CLS: RANDOMIZE
30 DIM p$(7,4,8): DIM q(7): RESTORE 900
40 FOR n=1 TO 7: READ q(n): FOR r=1 TO 4: READ p$(n,r): NEXT r: NEXT n
50 LET e$="": FOR i=1 TO 10: LET e$=e$+CHR$ 17+CHR$ 0+" ": NEXT i
60 LET hi=0
100 REM the title
110 CLS: PRINT AT 3,13; INK 6;"TETRIS"
120 PRINT AT 7,8;"O left    P right"
130 PRINT AT 9,8;"Q turn    A down"
140 PRINT AT 11,8;"SPACE drop"
150 PRINT AT 14,8;"High score ";hi
160 PRINT AT 18,5; FLASH 1;" Press any key to play "
170 PAUSE 0: CLS
200 REM a new game
210 DIM r$(20,30): DIM c(20): FOR y=1 TO 20: LET r$(y)=e$: NEXT y
220 FOR y=1 TO 20: PRINT AT y,10; PAPER 7;" "; AT y,21;" ": NEXT y: PRINT AT 21,10; PAPER 7;"            ";
230 LET tp=21: LET sc=0: LET ln=0: LET lv=1: LET dl=25: LET l$="": LET np=1+INT (RND*7)
240 PRINT AT 1,23; INK 6;"TETRIS"; AT 4,23;"NEXT": GO SUB 850
300 REM a new piece
310 LET n=np: LET np=1+INT (RND*7): GO SUB 800
320 LET r=1: LET rr=1: GO SUB 780: GO SUB 690: LET x=4: LET y=0: LET c=q(n)
330 LET xx=14: LET ok=ATTR (y1,xx+x1)=71 AND ATTR (y2,xx+x2)=71 AND ATTR (y3,xx+x3)=71 AND ATTR (y4,xx+x4)=71
340 IF NOT ok THEN GO TO 600
350 GO SUB 670: LET t=PEEK 23672
400 REM the piece falls
410 LET k$=INKEY$
420 IF k$="o" OR k$="O" THEN LET dy=0: LET dx=-1: GO SUB 650
430 IF k$="p" OR k$="P" THEN LET dy=0: LET dx=1: GO SUB 650
440 IF (k$="q" OR k$="Q") AND l$<>k$ THEN GO SUB 700
450 IF k$=" " THEN GO TO 500
460 LET l$=k$: LET f=PEEK 23672-t: IF f<0 THEN LET f=f+256
470 IF f<dl AND k$<>"a" AND k$<>"A" THEN GO TO 410
480 LET t=PEEK 23672: LET dy=1: LET dx=0: GO SUB 650: IF ok THEN GO TO 410
490 GO TO 520
500 GO SUB 660: LET xx=10+x
505 LET yy=y+1: IF ATTR (yy+y1,xx+x1)=71 AND ATTR (yy+y2,xx+x2)=71 AND ATTR (yy+y3,xx+x3)=71 AND ATTR (yy+y4,xx+x4)=71 THEN LET y=yy: GO TO 505
510 GO SUB 670: LET l$=" "
520 REM the piece lands
530 IF y+y1<1 OR y+y2<1 OR y+y3<1 OR y+y4<1 THEN GO TO 600
540 LET r$(y+y1,3*(x+x1)-1)=CHR$ c: LET r$(y+y2,3*(x+x2)-1)=CHR$ c: LET r$(y+y3,3*(x+x3)-1)=CHR$ c: LET r$(y+y4,3*(x+x4)-1)=CHR$ c
545 LET c(y+y1)=c(y+y1)+1: LET c(y+y2)=c(y+y2)+1: LET c(y+y3)=c(y+y3)+1: LET c(y+y4)=c(y+y4)+1: BEEP .005,0
550 IF y<tp THEN LET tp=y: IF tp<1 THEN LET tp=1
555 LET cl=0: FOR z=y TO y+3: IF z>=1 AND z<=20 THEN IF c(z)=10 THEN LET cl=cl+1: LET zm=z: PRINT AT z,11; PAPER 7;"          ";
560 NEXT z: IF NOT cl THEN GO TO 590
565 BEEP .05,12+4*cl: LET s=zm: FOR w=zm TO 1 STEP -1
570 IF s>=1 THEN IF c(s)=10 THEN LET s=s-1: GO TO 570
575 IF s>=1 THEN LET r$(w)=r$(s): LET c(w)=c(s): LET s=s-1: GO TO 585
580 LET r$(w)=e$: LET c(w)=0
585 NEXT w: FOR w=tp TO zm: PRINT AT w,11;r$(w);: NEXT w: LET tp=tp+cl
587 LET ln=ln+cl: LET sc=sc+lv*(100*(cl=1)+300*(cl=2)+500*(cl=3)+800*(cl=4)): LET lv=1+INT (ln/10): LET dl=27-2*lv: IF dl<3 THEN LET dl=3
590 GO SUB 850: GO TO 300
600 REM game over
610 IF sc>hi THEN LET hi=sc
620 GO SUB 850: PRINT AT 10,11; PAPER 2; FLASH 1;"GAME OVER ": BEEP .5,-20
630 PAUSE 200: GO TO 100
650 REM the piece moved by dy,dx if it fits there; ok says if it did
655 GO SUB 660: LET yy=y+dy: LET xx=10+x+dx: LET ok=ATTR (yy+y1,xx+x1)=71 AND ATTR (yy+y2,xx+x2)=71 AND ATTR (yy+y3,xx+x3)=71 AND ATTR (yy+y4,xx+x4)=71
657 IF ok THEN LET y=yy: LET x=x+dx
659 GO TO 670
660 REM the piece rubbed out
665 PRINT PAPER 0;AT y+y1,10+x+x1;" ";AT y+y2,10+x+x2;" ";AT y+y3,10+x+x3;" ";AT y+y4,10+x+x4;" ";: RETURN
670 REM the piece drawn
675 PRINT PAPER c;AT y+y1,10+x+x1;" ";AT y+y2,10+x+x2;" ";AT y+y3,10+x+x3;" ";AT y+y4,10+x+x4;" ";: RETURN
690 REM the piece takes the cells loaded for turn rr
695 LET r=rr: LET y1=i1: LET x1=j1: LET y2=i2: LET x2=j2: LET y3=i3: LET x3=j3: LET y4=i4: LET x4=j4: RETURN
700 REM the piece turned, if it fits that way
705 LET rr=r+1-4*(r=4): GO SUB 780: GO SUB 660: LET xx=10+x
710 LET ok=ATTR (y+i1,xx+j1)=71 AND ATTR (y+i2,xx+j2)=71 AND ATTR (y+i3,xx+j3)=71 AND ATTR (y+i4,xx+j4)=71
720 IF ok THEN GO SUB 690: BEEP .003,30
730 GO TO 670
780 REM the cells of piece n turned rr, into i1 to i4 and j1 to j4
785 LET i1=CODE p$(n,rr,1)-48: LET j1=CODE p$(n,rr,2)-48: LET i2=CODE p$(n,rr,3)-48: LET j2=CODE p$(n,rr,4)-48
790 LET i3=CODE p$(n,rr,5)-48: LET j3=CODE p$(n,rr,6)-48: LET i4=CODE p$(n,rr,7)-48: LET j4=CODE p$(n,rr,8)-48: RETURN
800 REM the next piece
810 FOR w=5 TO 8: PRINT AT w,24;"    ";: NEXT w
820 FOR k=1 TO 7 STEP 2: PRINT AT 5+CODE p$(np,1,k)-48,24+CODE p$(np,1,k+1)-48; PAPER q(np);" ";: NEXT k: RETURN
850 REM the score
860 PRINT AT 10,23;"SCORE"; AT 11,23;sc; AT 13,23;"LINES"; AT 14,23;ln; AT 16,23;"LEVEL"; AT 17,23;lv; AT 19,23;"HIGH"; AT 20,23;hi;: RETURN
900 REM each piece: its colour, then its cells for each of the 4 ways it turns
910 DATA 5,"10111213","02122232","10111213","02122232"
920 DATA 6,"01021112","01021112","01021112","01021112"
930 DATA 3,"01101112","01111221","10111221","01101121"
940 DATA 4,"01021011","00101121","01021011","00101121"
950 DATA 2,"00011112","01101120","00011112","01101120"
960 DATA 1,"00101112","01021121","10111222","01112021"
970 DATA 7,"02101112","01112122","10111220","00011121"

# run: the HOME cartridge's menu. With the Interface 1 connected, typing
# RUN on a Spectrum with no program in it loads the file called "run"
# from Microdrive 1, so this starts by itself.
10 REM run
20 BORDER 0: PAPER 0: INK 7: CLS
30 PRINT AT 1,8; INK 6;"HOME CARTRIDGE"
40 PRINT AT 5,2;"1  The guessing game"
50 PRINT AT 7,2;"2  The files on this cartridge"
60 PRINT AT 9,2;"3  The files on the DATA"'"     cartridge, in Microdrive 2"
70 PRINT AT 14,0; INK 5;"The guessing game learns, and"'"keeps what it learns on the DATA"'"cartridge."
80 PAUSE 0: LET k$=CHR$ PEEK 23560
90 IF k$="1" THEN CLS: PRINT AT 10,2;"Loading the guessing game...": LOAD *"m";1;"guess"
100 IF k$="2" THEN CLS: CAT 1: GO TO 200
110 IF k$="3" THEN CLS: CAT 2: GO TO 200
120 GO TO 80
200 PRINT '"Press a key for the menu.": PAUSE 0: RUN

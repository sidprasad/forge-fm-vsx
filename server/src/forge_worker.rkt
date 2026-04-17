#lang racket
;; Persistent Forge syntax-check worker. Speaks a line-delimited s-expression
;; protocol over stdio. Replaces the TCP-on-port-8879 scheme in syntax_check.rkt.
;;
;; Protocol (each message on its own line, except `check` which is followed by
;; raw source bytes whose length is given in the header):
;;
;;   (ping ID)                              -> (pong ID)
;;   (check ID LEN)\n<LEN bytes of source>  -> (ok ID)
;;                                         |  (error ID ((LINE COL POS SPAN SEVERITY MSG) ...))
;;   (cancel ID)                            -> no reply (best-effort)
;;   (shutdown)                             -> exits 0
;;
;; All positions are 1-indexed as Racket reports them. The TS side converts to
;; 0-indexed LSP positions. LEN is a byte count (UTF-8).

(require (only-in forge/lang/alloy-syntax/parser parse)
         (only-in forge/lang/alloy-syntax/tokenizer make-tokenizer))

(define out (current-output-port))
(define in  (current-input-port))
(define err (current-error-port))

(define (reply . parts)
  (write (cons (car parts) (cdr parts)) out)
  (newline out)
  (flush-output out))

;; Extract (line col pos span) from an exception. Uses structured accessors when
;; available, then falls back to parsing `[line=N, column=N, offset=N]` out of
;; the message (the format produced by Forge's parser and raise-forge-error).
(define (exn->locs e)
  (cond
    [(exn:fail:read? e)
     (for/list ([s (in-list (exn:fail:read-srclocs e))]
                #:when (srcloc? s))
       (list (or (srcloc-line s) 1)
             (or (srcloc-column s) 0)
             (or (srcloc-position s) 1)
             (or (srcloc-span s) 1)))]
    [(exn:fail:syntax? e)
     (for/list ([x (in-list (exn:fail:syntax-exprs e))]
                #:when (syntax? x))
       (list (or (syntax-line x) 1)
             (or (syntax-column x) 0)
             (or (syntax-position x) 1)
             (or (syntax-span x) 1)))]
    [else
     (define m (exn-message e))
     ;; Forge parser:       "... [line=L, column=C, offset=O]"
     ;; raise-forge-error:  "[file:L:C (span N)] msg"
     (define frg-re #px"\\[line=(\\d+),\\s*column=(\\d+),\\s*offset=(\\d+)\\]")
     (define pretty-re #px"\\[[^]]*?:(\\d+):(\\d+)\\s*\\(span\\s*(\\d+)\\)\\]")
     (cond
       [(regexp-match frg-re m)
        => (lambda (g)
             (define line (string->number (list-ref g 1)))
             (define col  (string->number (list-ref g 2)))
             (define off  (string->number (list-ref g 3)))
             (list (list line col off 1)))]
       [(regexp-match pretty-re m)
        => (lambda (g)
             (define line (string->number (list-ref g 1)))
             (define col  (string->number (list-ref g 2)))
             (define span (string->number (list-ref g 3)))
             (list (list line col 1 span)))]
       [else '()])]))

(define (check-source id src)
  (with-handlers
    ([exn:fail?
      (lambda (e)
        (define locs (exn->locs e))
        (define msg  (exn-message e))
        (define diag
          (if (null? locs)
              (list (list 1 0 1 1 'error msg))
              (for/list ([loc (in-list locs)])
                (append loc (list 'error msg)))))
        (reply 'error id diag))])
    (call-with-input-string src
      (lambda (p) (parse 'forge-check (make-tokenizer p))))
    (reply 'ok id)))

(define (read-check-body len)
  ;; `len` is a UTF-8 byte count. Read raw bytes, then decode.
  (define bs (read-bytes len in))
  (cond
    [(eof-object? bs) ""]
    [(bytes? bs) (bytes->string/utf-8 bs #\?)]
    [else ""]))

(define (main-loop)
  (define msg (read in))
  (cond
    [(eof-object? msg) (void)]
    [(and (list? msg) (not (null? msg)))
     (case (car msg)
       [(ping)
        (reply 'pong (cadr msg))
        (main-loop)]
       [(check)
        ;; (check ID LEN)
        (define id  (cadr msg))
        (define len (caddr msg))
        ;; Racket's `read` leaves the trailing newline in the input; skip one.
        (define c (peek-char in))
        (when (eqv? c #\newline) (read-char in))
        (define src (read-check-body len))
        (check-source id src)
        (main-loop)]
       [(cancel)
        ;; Parsing is synchronous; nothing to do. Acknowledge silently.
        (main-loop)]
       [(shutdown)
        (exit 0)]
       [else
        (fprintf err "forge_worker: unknown message ~s~n" msg)
        (main-loop)])]
    [else
     (fprintf err "forge_worker: malformed message ~s~n" msg)
     (main-loop)]))

(main-loop)

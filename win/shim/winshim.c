/* NetHack 5.0 winshim.c    $NHDT-Date: 1781973099 2026/06/20 16:31:39 $  $NHDT-Branch: NetHack-5.0 $:$NHDT-Revision: 1.34 $ */
/* Copyright (c) Adam Powers, 2020                                */
/* NetHack may be freely redistributed.  See license for details. */
/* Modified for BlissHack by lightmain, 2026-09-02, 2026-09-06, and 2026-09-07:
 * preserve character selection quit semantics, expose narrow browser save
 * helpers, and synchronize a fixed set of in-game options at command
 * boundaries, including the permanent inventory capability and settings. */

/* not an actual windowing port, but a fake win port for libnethack */

#include "hack.h"
#include <string.h>

#ifdef SHIM_GRAPHICS
#include <stdarg.h>
/* for cross-compiling to WebAssembly (WASM) */
#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

#undef SHIM_DEBUG

#ifdef SHIM_DEBUG
#define debugf printf
#else /* !SHIM_DEBUG */
#define debugf(...)
#endif /* SHIM_DEBUG */


/* shim_graphics_callback is the primary interface to shim graphics,
 * call this function with your declared callback function
 * and you will receive all the windowing calls
 */
#ifdef __EMSCRIPTEN__
/************
 * WASM interface
 ************/
EMSCRIPTEN_KEEPALIVE
static char *shim_callback_name = NULL;
static boolean shim_restore_required = FALSE;
struct shim_critical_size_with_name {
    uchar ucsize;
    const char *name;
};
extern struct shim_critical_size_with_name critical_sizes[];
void shim_graphics_set_callback(char *cbName);
void shim_graphics_set_player_name(const char *player_name);
void shim_graphics_set_restore_required(int required);
int shim_graphics_get_save_fingerprint(uchar *outbuf, int outbufsz);

void shim_graphics_set_callback(char *cbName) {
    if (shim_callback_name != NULL) free(shim_callback_name);
    if(cbName && strlen(cbName) > 0) {
        debugf("setting shim_callback_name: %s\n", cbName);
        shim_callback_name = strdup(cbName);
    } else {
        debugf("un-setting shim_callback_name\n");
        shim_callback_name = NULL;
    }
    /* TODO: free(shim_callback_name) during shutdown? */
}

EMSCRIPTEN_KEEPALIVE
void
shim_graphics_set_player_name(const char *player_name)
{
    memset(svp.plname, 0, sizeof svp.plname);
    if (player_name) {
        strncpy(svp.plname, player_name, sizeof svp.plname - 1);
        (void) setenv("USER", player_name, 1);
        (void) setenv("LOGNAME", player_name, 1);
    }
}

EMSCRIPTEN_KEEPALIVE
void
shim_graphics_set_restore_required(int required)
{
    shim_restore_required = required ? TRUE : FALSE;
}

EMSCRIPTEN_KEEPALIVE
int
shim_graphics_get_save_fingerprint(uchar *outbuf, int outbufsz)
{
    struct version_info version_data;
    int count = get_critical_size_count(),
        required = 2 + count + (int) sizeof version_data, i;

    if (!outbuf || outbufsz < required)
        return required;

    runtime_info_init();
    outbuf[0] = (uchar) 'h';
    outbuf[1] = (uchar) count;
    for (i = 0; i < count; ++i)
        outbuf[2 + i] = critical_sizes[i].ucsize;

    version_data.incarnation = nomakedefs.version_number;
    version_data.feature_set = nomakedefs.version_features;
    version_data.entity_count = nomakedefs.version_sanity1;
    memcpy(&outbuf[2 + count], &version_data, sizeof version_data);
    return required;
}

void local_callback (const char *cb_name, const char *shim_name, void *ret_ptr, const char *fmt_str, void *args);

/* A2P = Argument to Pointer */
#define A2P &
/* P2V = Pointer to Void */
#define P2V (void *)
#define DECLCB(ret_type, name, fn_args, fmt, ...) \
ret_type name fn_args; \
\
ret_type name fn_args { \
    void *args[] = { __VA_ARGS__ }; \
    ret_type ret = (ret_type) 0; \
    debugf("SHIM GRAPHICS: " #name "\n"); \
    if (!shim_callback_name) return ret; \
    local_callback(shim_callback_name, #name, (void *)&ret, fmt, args); \
    debugf("SHIM GRAPHICS: " #name " done.\n"); \
    return ret; \
}

#define VDECLCB(name, fn_args, fmt, ...) \
void name fn_args; \
\
void name fn_args { \
    void *args[] = { __VA_ARGS__ }; \
    debugf("SHIM GRAPHICS: " #name "\n"); \
    if (!shim_callback_name) return; \
    local_callback(shim_callback_name, #name, NULL, fmt, args); \
    debugf("SHIM GRAPHICS: " #name " done.\n"); \
}

#else /* !__EMSCRIPTEN__ */

/************
 * libnethack.a interface
 ************/
typedef void(*shim_callback_t)(const char *name, void *ret_ptr, const char *fmt, ...);
static shim_callback_t shim_graphics_callback = NULL;
void shim_graphics_set_callback(shim_callback_t cb);

void shim_graphics_set_callback(shim_callback_t cb) {
    shim_graphics_callback = cb;
}

#define A2P
#define P2V
#define DECLCB(ret_type, name, fn_args, fmt, ...) \
ret_type name fn_args;\
\
ret_type name fn_args { \
    ret_type ret = (ret_type) 0; \
    debugf("SHIM GRAPHICS: " #name "\n"); \
    if (!shim_graphics_callback) return ret; \
    shim_graphics_callback(#name, (void *)&ret, fmt, ## __VA_ARGS__); \
    debugf("SHIM GRAPHICS: " #name " done.\n"); \
    return ret; \
}

#define VDECLCB(name, fn_args, fmt, ...) \
void name fn_args;\
\
void name fn_args { \
    debugf("SHIM GRAPHICS: " #name "\n"); \
    if (!shim_graphics_callback) return; \
    shim_graphics_callback(#name, NULL, fmt, ## __VA_ARGS__); \
    debugf("SHIM GRAPHICS: " #name " done.\n"); \
}
#endif /* __EMSCRIPTEN__ */

VDECLCB(shim_init_nhwindows,(int *argcp, char **argv), "vpp", P2V argcp, P2V argv)
DECLCB(boolean, shim_player_selection_or_tty,(void), "b")
VDECLCB(shim_askname,(void), "v")
#ifdef __EMSCRIPTEN__
#define SHIM_SETTINGS_VERSION 2U
#define SHIM_SETTINGS_PENDING (1U << 0)
#define SHIM_SETTINGS_AUTOPICKUP (1U << 1)
#define SHIM_SETTINGS_SAFE_PET (1U << 2)
#define SHIM_SETTINGS_SORTPACK (1U << 3)
#define SHIM_SETTINGS_SHOWEXP (1U << 4)
#define SHIM_SETTINGS_TIME (1U << 5)
#define SHIM_SETTINGS_PICKUP_ALL (1U << 6)
#define SHIM_SETTINGS_NUMPAD_SHIFT 7
#define SHIM_SETTINGS_NUMPAD_MASK (7U << SHIM_SETTINGS_NUMPAD_SHIFT)
#define SHIM_SETTINGS_PICKUP_SHIFT 10
#define SHIM_SETTINGS_PICKUP_MASK (0x7fffU << SHIM_SETTINGS_PICKUP_SHIFT)
#define SHIM_SETTINGS_PERM_INVENT (1U << 25)
#define SHIM_SETTINGS_PERMINV_MODE_SHIFT 26
#define SHIM_SETTINGS_PERMINV_MODE_MASK \
    (3U << SHIM_SETTINGS_PERMINV_MODE_SHIFT)
#define SHIM_SETTINGS_VERSION_SHIFT 28
#define SHIM_SETTINGS_VERSION_MASK (7U << SHIM_SETTINGS_VERSION_SHIFT)
#define SHIM_SETTINGS_DEFINED_MASK \
    (SHIM_SETTINGS_PENDING | SHIM_SETTINGS_AUTOPICKUP \
     | SHIM_SETTINGS_SAFE_PET | SHIM_SETTINGS_SORTPACK \
     | SHIM_SETTINGS_SHOWEXP | SHIM_SETTINGS_TIME \
     | SHIM_SETTINGS_PICKUP_ALL | SHIM_SETTINGS_NUMPAD_MASK \
     | SHIM_SETTINGS_PICKUP_MASK | SHIM_SETTINGS_PERM_INVENT \
     | SHIM_SETTINGS_PERMINV_MODE_MASK | SHIM_SETTINGS_VERSION_MASK)

static const char shim_pickup_symbols[] = "$\")[%?+!=/(*`0_";
static const int shim_numpad_modes[] = { 0, 1, 2, 3, 4, -1 };

/* Encode the nine supported live options in the versioned WASM payload. */
static unsigned int
shim_settings_snapshot(void)
{
    unsigned int payload = SHIM_SETTINGS_VERSION
                           << SHIM_SETTINGS_VERSION_SHIFT;
    const char *value;
    int i, mode = 0;

    if (flags.pickup)
        payload |= SHIM_SETTINGS_AUTOPICKUP;
    if (flags.safe_dog)
        payload |= SHIM_SETTINGS_SAFE_PET;
    if (flags.sortpack)
        payload |= SHIM_SETTINGS_SORTPACK;
    if (flags.showexp)
        payload |= SHIM_SETTINGS_SHOWEXP;
    if (flags.time)
        payload |= SHIM_SETTINGS_TIME;
    if (iflags.perm_invent)
        payload |= SHIM_SETTINGS_PERM_INVENT;
    switch (iflags.perminv_mode) {
    case InvOptFull:
    case InvOptFull_grid:
        mode = 2;
        break;
    case InvOptInUse:
        mode = 3;
        break;
    case InvOptOn:
    case InvOptOn_grid:
        mode = 1;
        break;
    default:
        mode = 0;
        break;
    }
    payload |= (unsigned int) mode << SHIM_SETTINGS_PERMINV_MODE_SHIFT;

    value = get_option_value("pickup_types", TRUE);
    if (value && !strcmp(value, "all")) {
        payload |= SHIM_SETTINGS_PICKUP_ALL;
    } else if (value) {
        for (i = 0; shim_pickup_symbols[i]; ++i)
            if (strchr(value, shim_pickup_symbols[i]))
                payload |= 1U << (SHIM_SETTINGS_PICKUP_SHIFT + i);
    }

    mode = 0;
    value = get_option_value("number_pad", TRUE);
    if (value) {
        mode = atoi(value);
        for (i = 0; i < SIZE(shim_numpad_modes); ++i)
            if (shim_numpad_modes[i] == mode)
                break;
        mode = i;
    }
    payload |= (unsigned int) mode << SHIM_SETTINGS_NUMPAD_SHIFT;
    return payload;
}

/* Reject malformed or unsupported payloads before option parsing. */
static boolean
shim_settings_payload_valid(unsigned int payload, boolean require_pending)
{
    unsigned int version, numpad, pickup, perminv_mode;

    if (payload & ~SHIM_SETTINGS_DEFINED_MASK)
        return FALSE;
    version = (payload & SHIM_SETTINGS_VERSION_MASK)
              >> SHIM_SETTINGS_VERSION_SHIFT;
    if (version != SHIM_SETTINGS_VERSION)
        return FALSE;
    if (require_pending && !(payload & SHIM_SETTINGS_PENDING))
        return FALSE;
    numpad = (payload & SHIM_SETTINGS_NUMPAD_MASK)
             >> SHIM_SETTINGS_NUMPAD_SHIFT;
    if (numpad >= SIZE(shim_numpad_modes))
        return FALSE;
    pickup = (payload & SHIM_SETTINGS_PICKUP_MASK)
             >> SHIM_SETTINGS_PICKUP_SHIFT;
    if ((payload & SHIM_SETTINGS_PICKUP_ALL) && pickup)
        return FALSE;
    if (!(payload & SHIM_SETTINGS_PICKUP_ALL) && !pickup)
        return FALSE;
    perminv_mode = (payload & SHIM_SETTINGS_PERMINV_MODE_MASK)
                   >> SHIM_SETTINGS_PERMINV_MODE_SHIFT;
    if ((payload & SHIM_SETTINGS_PERM_INVENT) && !perminv_mode)
        return FALSE;
    if (require_pending && !perminv_mode)
        return FALSE;
    return TRUE;
}

/* Apply one validated complete payload through NetHack's option parser. */
static boolean
shim_apply_settings(unsigned int payload)
{
    char opts[BUFSZ], *op;
    unsigned int pickup;
    int i, numpad, perminv_mode;
    boolean applied = TRUE, old_opt_initial = go.opt_initial,
            old_opt_from_file = go.opt_from_file,
            old_sortpack = flags.sortpack,
            old_showexp = flags.showexp, old_time = flags.time,
            old_perm_invent = iflags.perm_invent;
    uchar old_perminv_mode = iflags.perminv_mode;

#define SHIM_APPLY_BOOLEAN(name, bit) \
    Sprintf(opts, "%s" name, (payload & (bit)) ? "" : "!"); \
    if (!parseoptions(opts, TRUE, FALSE)) { \
        applied = FALSE; \
        goto shim_apply_done; \
    }

    if (!shim_settings_payload_valid(payload, FALSE))
        return FALSE;
    SHIM_APPLY_BOOLEAN("autopickup", SHIM_SETTINGS_AUTOPICKUP);

    if (payload & SHIM_SETTINGS_PICKUP_ALL) {
        Strcpy(opts, "pickup_types:all");
    } else {
        Strcpy(opts, "pickup_types:");
        op = eos(opts);
        pickup = (payload & SHIM_SETTINGS_PICKUP_MASK)
                 >> SHIM_SETTINGS_PICKUP_SHIFT;
        for (i = 0; shim_pickup_symbols[i]; ++i)
            if (pickup & (1U << i))
                *op++ = shim_pickup_symbols[i];
        *op = '\0';
    }
    if (!parseoptions(opts, TRUE, FALSE)) {
        applied = FALSE;
        goto shim_apply_done;
    }

    numpad = (payload & SHIM_SETTINGS_NUMPAD_MASK)
             >> SHIM_SETTINGS_NUMPAD_SHIFT;
    Sprintf(opts, "number_pad:%d", shim_numpad_modes[numpad]);
    if (!parseoptions(opts, TRUE, FALSE)) {
        applied = FALSE;
        goto shim_apply_done;
    }
    SHIM_APPLY_BOOLEAN("safe_pet", SHIM_SETTINGS_SAFE_PET);
    SHIM_APPLY_BOOLEAN("sortpack", SHIM_SETTINGS_SORTPACK);
    SHIM_APPLY_BOOLEAN("showexp", SHIM_SETTINGS_SHOWEXP);
    SHIM_APPLY_BOOLEAN("time", SHIM_SETTINGS_TIME);
    perminv_mode = (payload & SHIM_SETTINGS_PERMINV_MODE_MASK)
                   >> SHIM_SETTINGS_PERMINV_MODE_SHIFT;
    Sprintf(opts, "perminv_mode:%s",
            perminv_mode == 2 ? "full"
            : perminv_mode == 3 ? "in-use" : "all");
    if (!parseoptions(opts, TRUE, FALSE)) {
        applied = FALSE;
        goto shim_apply_done;
    }
    SHIM_APPLY_BOOLEAN("perm_invent", SHIM_SETTINGS_PERM_INVENT);
shim_apply_done:
#undef SHIM_APPLY_BOOLEAN
    go.opt_initial = old_opt_initial;
    go.opt_from_file = old_opt_from_file;
    if (applied && (flags.showexp != old_showexp || flags.time != old_time)) {
        if (VIA_WINDOWPORT())
            status_initialize(REASSESS_ONLY);
        disp.botl = TRUE;
    }
    if (applied
        && (flags.sortpack != old_sortpack
            || iflags.perm_invent != old_perm_invent
            || iflags.perminv_mode != old_perminv_mode))
        update_inventory();
    return applied;
}

/* Publish a snapshot and retrieve at most one pending TypeScript update. */
static int
shim_settings_sync(int snapshot)
{
    void *args[] = { &snapshot };
    int update = 0;

    if (shim_callback_name)
        local_callback(shim_callback_name, "shim_settings_sync",
                       (void *) &update, "ii", args);
    return update;
}

/* Report whether an update applied and return the authoritative snapshot. */
static void
shim_settings_result(int success, int snapshot)
{
    void *args[] = { &success, &snapshot };

    if (shim_callback_name)
        local_callback(shim_callback_name, "shim_settings_result",
                       NULL, "vii", args);
}

/* Exchange runtime settings at the existing command-loop safe boundary. */
void
shim_get_nh_event(void)
{
    unsigned int before = shim_settings_snapshot(),
                 update = (unsigned int) shim_settings_sync((int) before),
                 after;
    boolean valid, applied = FALSE;

    if (!update)
        return;
    valid = shim_settings_payload_valid(update, TRUE);
    if (valid)
        applied = shim_apply_settings(update);
    after = shim_settings_snapshot();
    if (applied
        && after != (update & ~SHIM_SETTINGS_PENDING))
        applied = FALSE;
    if (!applied && valid) {
        (void) shim_apply_settings(before);
        after = shim_settings_snapshot();
    }
    shim_settings_result(applied ? 1 : 0, (int) after);
}
#else
VDECLCB(shim_get_nh_event,(void), "v")
#endif
VDECLCB(shim_exit_nhwindows,(const char *str), "vs", P2V str)
VDECLCB(shim_suspend_nhwindows,(const char *str), "vs", P2V str)
VDECLCB(shim_resume_nhwindows,(void), "v")
DECLCB(winid, shim_create_nhwindow, (int type), "ii", A2P type)
VDECLCB(shim_clear_nhwindow,(winid window), "vi", A2P window)
VDECLCB(shim_display_nhwindow,(winid window, boolean blocking), "vib", A2P window, A2P blocking)
VDECLCB(shim_destroy_nhwindow,(winid window), "vi", A2P window)
VDECLCB(shim_curs,(winid a, int x, int y), "viii", A2P a, A2P x, A2P y)
VDECLCB(shim_putstr,(winid w, int attr, const char *str), "viis", A2P w, A2P attr, P2V str)
VDECLCB(shim_display_file,(const char *name, boolean complain), "vsb", P2V name, A2P complain)
VDECLCB(shim_start_menu,(winid window, unsigned long mbehavior), "vii", A2P window, A2P mbehavior)
VDECLCB(shim_add_menu,
    (winid window, const glyph_info *glyphinfo, const ANY_P *identifier, char ch, char gch, int attr, int clr, const char *str, unsigned int itemflags),
    "vipi00iisi",
    A2P window, P2V glyphinfo, P2V identifier, A2P ch, A2P gch, A2P attr, A2P clr, P2V str, A2P itemflags)
VDECLCB(shim_end_menu,(winid window, const char *prompt), "vis", A2P window, P2V prompt)
/* XXX: shim_select_menu menu_list is an output */
DECLCB(int, shim_select_menu,(winid window, int how, MENU_ITEM_P **menu_list), "iiip", A2P window, A2P how, P2V menu_list)
DECLCB(char, shim_message_menu,(char let, int how, const char *mesg), "ciis", A2P let, A2P how, P2V mesg)
VDECLCB(shim_mark_synch,(void), "v")
VDECLCB(shim_wait_synch,(void), "v")
VDECLCB(shim_cliparound,(int x, int y), "vii", A2P x, A2P y)
VDECLCB(shim_update_positionbar,(char *posbar), "vs", P2V posbar)
VDECLCB(shim_print_glyph,(winid w, coordxy x, coordxy y, const glyph_info *glyphinfo, const glyph_info *bkglyphinfo), "vi11pp", A2P w, A2P x, A2P y, P2V glyphinfo, P2V bkglyphinfo)
VDECLCB(shim_raw_print,(const char *str), "vs", P2V str)
VDECLCB(shim_raw_print_bold,(const char *str), "vs", P2V str)
#ifdef __EMSCRIPTEN__
/* Wait for one key and expose whether the core expects a top-level command. */
int
shim_nhgetch(void)
{
    int input_state = program_state.input_state, result = 0;
    void *args[] = { &input_state };

    if (shim_callback_name)
        local_callback(shim_callback_name, "shim_nhgetch",
                       (void *) &result, "ii", args);
    return result;
}

/* Wait for a key or position and append the current input state to the ABI. */
int
shim_nh_poskey(coordxy *x, coordxy *y, int *mod)
{
    int input_state = program_state.input_state, result = 0;
    void *args[] = { x, y, mod, &input_state };

    if (shim_callback_name)
        local_callback(shim_callback_name, "shim_nh_poskey",
                       (void *) &result, "ipppi", args);
    return result;
}
#else
DECLCB(int, shim_nhgetch,(void), "i")
DECLCB(int, shim_nh_poskey,(coordxy *x, coordxy *y, int *mod), "ippp", P2V x, P2V y, P2V mod)
#endif
VDECLCB(shim_nhbell,(void), "v")
DECLCB(int, shim_doprev_message,(void),"iv")
DECLCB(char, shim_yn_function,(const char *query, const char *resp, char def), "css0", P2V query, P2V resp, A2P def)
VDECLCB(shim_getlin,(const char *query, char *bufp), "vsp", P2V query, P2V bufp)
DECLCB(int,shim_get_ext_cmd,(void),"iv")
VDECLCB(shim_number_pad,(int state), "vi", A2P state)
VDECLCB(shim_delay_output,(void), "v")
VDECLCB(shim_change_color,(int color, long rgb, int reverse), "viii", A2P color, A2P rgb, A2P reverse)
VDECLCB(shim_change_background,(int white_or_black), "vi", A2P white_or_black)
DECLCB(short, set_shim_font_name,(winid window_type, char *font_name),"2is", A2P window_type, P2V font_name)
DECLCB(char *,shim_get_color_string,(void),"sv")

VDECLCB(shim_preference_update, (const char *pref), "vp", P2V pref)
DECLCB(char *,shim_getmsghistory, (boolean init), "sb", A2P init)
VDECLCB(shim_putmsghistory, (const char *msg, boolean restoring_msghist), "vsb", P2V msg, A2P restoring_msghist)
VDECLCB(shim_status_init, (void), "v")
VDECLCB(shim_status_enablefield,
    (int fieldidx, const char *nm, const char *fmt, boolean enable),
    "vippb",
    A2P fieldidx, P2V nm, P2V fmt, A2P enable)
/* XXX: the second argument to shim_status_update is sometimes an integer and sometimes a pointer */
VDECLCB(shim_status_update,
    (int fldidx, genericptr_t ptr, int chg, int percent, int color, unsigned long *colormasks),
    "vipiiip",
    A2P fldidx, P2V ptr, A2P chg, A2P percent, A2P color, P2V colormasks)
#ifdef __EMSCRIPTEN__
/* XXX: calling repopulate_perminvent() from shim_update_inventory() causes reentrancy that breaks emscripten Asyncify */
/* this should be fine since according to windows.doc, the only purpose of shim_update_inventory() is to call repopulate_perminvent() */
void shim_update_inventory(int a1 UNUSED) {
    if(iflags.perm_invent) {
        repopulate_perminvent();
    }
}

void shim_player_selection() {
    boolean do_genl_player_setup = shim_player_selection_or_tty();
    if (shim_restore_required)
        nh_terminate(EXIT_FAILURE);
    if (do_genl_player_setup && !genl_player_setup(80))
        nh_terminate(EXIT_SUCCESS);
}

win_request_info *
shim_ctrl_nhwindow(
    winid window UNUSED,
    int request UNUSED,
    win_request_info *wri UNUSED) {
    return (win_request_info *) 0;
}
#else /* !__EMSCRIPTEN__ */
VDECLCB(shim_player_selection, (void), "v")
VDECLCB(shim_update_inventory,(int a1 UNUSED), "vi", A2P a1)
DECLCB(win_request_info *, shim_ctrl_nhwindow,
    (winid window, int request, win_request_info *wri),
    "viip",
    A2P window, A2P request, P2V wri)
#endif

/* Interface definition used in windows.c */
struct window_procs shim_procs = {
    WPID(shim),
    (0
     | WC_ASCII_MAP
     | WC_MOUSE_SUPPORT
     | WC_COLOR | WC_HILITE_PET | WC_INVERSE | WC_EIGHT_BIT_IN
#ifdef __EMSCRIPTEN__
     | WC_PERM_INVENT
#endif
     ),
    (0
#if defined(SELECTSAVED)
     | WC2_SELECTSAVED
#endif
#if defined(STATUS_HILITES)
     | WC2_HILITE_STATUS | WC2_HITPOINTBAR | WC2_FLUSH_STATUS
     | WC2_RESET_STATUS
#endif
     | WC2_DARKGRAY | WC2_SUPPRESS_HIST | WC2_STATUSLINES),
    {1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1},   /* color availability */
    shim_init_nhwindows, shim_player_selection, shim_askname, shim_get_nh_event,
    shim_exit_nhwindows, shim_suspend_nhwindows, shim_resume_nhwindows,
    shim_create_nhwindow, shim_clear_nhwindow, shim_display_nhwindow,
    shim_destroy_nhwindow, shim_curs, shim_putstr, genl_putmixed,
    shim_display_file, shim_start_menu, shim_add_menu, shim_end_menu,
    shim_select_menu, shim_message_menu, shim_mark_synch,
    shim_wait_synch,
#ifdef CLIPPING
    shim_cliparound,
#endif
#ifdef POSITIONBAR
    shim_update_positionbar,
#endif
    shim_print_glyph, shim_raw_print, shim_raw_print_bold, shim_nhgetch,
    shim_nh_poskey, shim_nhbell, shim_doprev_message, shim_yn_function,
    shim_getlin, shim_get_ext_cmd, shim_number_pad, shim_delay_output,
#ifdef CHANGE_COLOR /* the Mac uses a palette device */
    shim_change_color,
#ifdef MAC
    shim_change_background, set_shim_font_name,
#endif
    shim_get_color_string,
#endif

    genl_outrip,
    shim_preference_update,
    shim_getmsghistory, shim_putmsghistory,
    shim_status_init,
    genl_status_finish, genl_status_enablefield,
#ifdef STATUS_HILITES
    shim_status_update,
#else
    genl_status_update,
#endif
    genl_can_suspend_yes,
    shim_update_inventory,
    shim_ctrl_nhwindow,
};

#ifdef __EMSCRIPTEN__
/* convert the C callback to a JavaScript callback */
EM_JS(void, local_callback, (const char *cb_name, const char *shim_name, void *ret_ptr, const char *fmt_str, void *args), {
    // Asyncify.handleAsync() is the more logical choice here; however, the stack unrolling in Asyncify is performed by
    // function call analysis during compilation. Since we are using an indirect callback (cb_name), it can't predict the stack
    // unrolling and it crashes. Thus we use Asyncify.handleSleep() and wakeUp() to make sure that async doesn't break
    // Asyncify. For details, see: https://emscripten.org/docs/porting/asyncify.html#optimizing
    Asyncify.handleSleep(wakeUp => {
        // convert callback arguments to proper JavaScript variadic arguments
        let name = UTF8ToString(shim_name);
        let fmt = UTF8ToString(fmt_str);
        let cbName = UTF8ToString(cb_name);
        // console.log("local_callback:", cbName, fmt, name);

        // get pointer / type conversion helpers
        let getPointerValue = globalThis.nethackGlobal.helpers.getPointerValue;
        let setPointerValue = globalThis.nethackGlobal.helpers.setPointerValue;

        reentryMutexLock(name);

        let argTypes = fmt.split("");
        let retType = argTypes.shift();

        // build array of JavaScript args from WASM parameters
        let jsArgs = [];
        for (let i = 0; i < argTypes.length; i++) {
            let ptr = args + (4*i);
            let val = getArg(name, ptr, argTypes[i]);
            jsArgs.push(val);
        }

        // do the callback
        let userCallback = globalThis[cbName];
        userCallback.call(this, name, ... jsArgs).then((retVal) => {
            // save the return value
            setPointerValue(name, ret_ptr, retType, retVal);
            reentryMutexUnlock();
            try {
                wakeUp();
            } catch (e) {
                
            }
        });

        function getArg(name, ptr, type) {
            return (type === "p") ? getValue(ptr, "*") : getPointerValue(name, getValue(ptr, "*"), type);
        }

        function reentryMutexLock(name) {
            globalThis.nethackGlobal = globalThis.nethackGlobal || {};
            if(globalThis.nethackGlobal.shimFunctionRunning) {
                console.error(`'${name}' attempting second call to 'local_callback' before '${globalThis.nethackGlobal.shimFunctionRunning}' has finished, will crash emscripten Asyncify. For details see: emscripten.org/docs/porting/asyncify.html#reentrancy`);
            }
            globalThis.nethackGlobal.shimFunctionRunning = name;
        }

        function reentryMutexUnlock() {
            globalThis.nethackGlobal.shimFunctionRunning = null;
        }
    });
})
#endif /* __EMSCRIPTEN__ */

#endif /* SHIM_GRAPHICS */

.class public Lcom/stepwise/game/NativeBridge;
.super Ljava/lang/Object;
.source "NativeBridge.java"


# annotations
.annotation system Ldalvik/annotation/EnclosingClass;
    value = Lcom/stepwise/game/MainActivity;
.end annotation

.annotation system Ldalvik/annotation/InnerClass;
    accessFlags = 0x1
    name = "NativeBridge"
.end annotation


# instance fields
.field final synthetic this$0:Lcom/stepwise/game/MainActivity;


# direct methods
.method constructor <init>(Lcom/stepwise/game/MainActivity;)V
    .registers 2

    iput-object p1, p0, Lcom/stepwise/game/NativeBridge;->this$0:Lcom/stepwise/game/MainActivity;

    invoke-direct {p0}, Ljava/lang/Object;-><init>()V

    return-void
.end method


# virtual methods
.method public vibrate(I)V
    .registers 3

    iget-object v0, p0, Lcom/stepwise/game/NativeBridge;->this$0:Lcom/stepwise/game/MainActivity;

    invoke-virtual {v0, p1}, Lcom/stepwise/game/MainActivity;->vibrate(I)V

    return-void
.end method

.method public isNative()Z
    .registers 2

    const/4 v0, 0x1

    return v0
.end method

.method public platform()Ljava/lang/String;
    .registers 2

    const-string v0, "android"

    return-object v0
.end method

.method public getTargetFps()I
    .registers 2

    const/16 v0, 0x3c

    return v0
.end method

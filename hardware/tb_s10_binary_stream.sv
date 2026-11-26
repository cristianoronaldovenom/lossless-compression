`timescale 1ns/1ps
module tb_s10_binary_stream;
reg clk=0; always #5 clk=~clk;
reg reset=1,in_valid=0,in_last=0,out_ready=0;
reg [63:0] in_indices=0;
reg [9:0] symbol0=0,symbol1=1023;
reg [6:0] in_bytes=0;
wire in_ready,out_valid,out_last,error;
wire [511:0] out_data; wire [63:0] out_keep;
s10_binary_stream dut(.*);
reg [7:0] expected[0:4095];
integer wr=0,rd=0,cycles=0,packets=0,expected_packets=0;
integer i,j,n,beat,t,offset;
reg [639:0] ref_bits;
reg [31:0] rng=32'h12345678;
always @(negedge clk) begin
    rng = {rng[30:0],rng[31]^rng[21]^rng[1]^rng[0]};
    out_ready = rng[0] | rng[3];
end
always @(posedge clk) if(!reset) begin
    cycles=cycles+1;
    if(cycles>20000) $fatal(1,"timeout");
    if(error) $fatal(1,"unexpected decoder error");
    if(out_valid && out_ready) begin
        for(integer x=0;x<64;x=x+1) if(out_keep[x]) begin
            if(rd>=wr || out_data[x*8+:8] !== expected[rd]) $fatal(1,"byte mismatch at %0d",rd);
            rd=rd+1;
        end
        if(out_last) packets=packets+1;
    end
end
task send(input integer bytes,input reg last,input reg [63:0] bits);
    integer k, cnt;
    reg [639:0] ref_data;
    reg [63:0] q;
    begin
        cnt=(bytes*8+9)/10;
        q=bits;
        if(last) begin
            if(cnt<64) q=q & ((64'b1<<cnt)-1);
            if(bytes*8%10!=0) q[cnt-1]=0;
        end
        for(k=0;k<64;k=k+1) ref_data[k*10+:10]=q[k]?symbol1:symbol0;
        for(k=0;k<bytes;k=k+1) begin expected[wr]=ref_data[k*8+:8]; wr=wr+1; end
        @(negedge clk); in_valid=1; in_indices=q; in_bytes=bytes; in_last=last;
        @(posedge clk); while(!in_ready) @(posedge clk);
        @(negedge clk); in_valid=0;
        if(last) expected_packets=expected_packets+1;
    end
endtask
initial begin
    repeat(3) @(negedge clk); reset=0;
    send(80,0,64'h123456789abcdef0); send(80,0,64'hfedcba9876543210); send(79,1,64'habcdef0123456789);
    for(n=1;n<=80;n=n+1) begin
        // Reuse scoreboard only once all previous bytes are consumed.
        wait(rd==wr && packets==expected_packets);
        @(negedge clk); wr=0; rd=0;
        send(n,1,64'h9876543210abcdef);
    end
    wait(rd==wr && packets==expected_packets);
    repeat(10) @(negedge clk);
    $display("PASS: backpressure and all 80 final lengths"); $finish;
end
endmodule

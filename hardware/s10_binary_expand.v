// Synthesizable binary-symbol expansion datapath, not a complete archive reader.
// 8 LSB-first indices -> 80 LSB-first output bits. One elastic output register.
// Input supplies already resolved original 10-bit values; host validates tail
// padding, byte count, metadata and checksum separately.
module s10_binary_expand(
    input wire clk, input wire reset,
    input wire in_valid, output wire in_ready,
    input wire [7:0] indices,
    input wire [9:0] symbol0, input wire [9:0] symbol1,
    output reg out_valid, input wire out_ready,
    output reg [79:0] decoded
);
    wire [79:0] expanded;
    genvar i;
    generate for(i=0;i<8;i=i+1) begin: mux
        assign expanded[10*i+:10]=indices[i]?symbol1:symbol0;
    end endgenerate
    assign in_ready=!out_valid||out_ready;
    always @(posedge clk) begin
        if(reset) begin out_valid<=0; decoded<=0; end
        else if(in_ready) begin
            out_valid<=in_valid;
            if(in_valid) decoded<=expanded;
        end
    end
endmodule
